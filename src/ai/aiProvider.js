'use strict';

/**
 * aiProvider.js
 *
 * Unified AI provider with automatic fallback chain:
 *   1. Google Gemini API   (fast, online, free tier available)
 *   2. Ollama local model  (offline fallback)
 *   3. Keyword scoring     (zero-dependency last resort)
 *
 * Usage:
 *   const { askAI, initAIProvider } = require('./aiProvider');
 *   initAIProvider(config);
 *   const response = await askAI(prompt, { temperature: 0.2, maxTokens: 300 });
 */

const axios = require('axios');
const logger = require('../utils/logger');

// ── Lazy-load ollamaManager to avoid circular deps ────────────────────────────
let _ollamaManager = null;
function _getOllamaManager() {
  if (!_ollamaManager) {
    try { _ollamaManager = require('./ollamaManager').ollamaManager; } catch (_) {}
  }
  return _ollamaManager;
}

// ── Short request-ID generator (for log correlation) ─────────────────────────
function _shortId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ── Socket log emitter (injected by server.js after init) ────────────────────
let _logEmitter = null;
/**
 * Inject the Socket.io emit function so AI logs stream to the Live Log panel.
 * Call once from server.js: setLogEmitter((event, data) => io.emit(event, data))
 */
function setLogEmitter(fn) { _logEmitter = fn; }

function _emitLog(level, msg, meta = {}) {
  if (!_logEmitter) return;
  try {
    _logEmitter('bot:log', { level, msg, ts: new Date().toISOString(), ...meta });
  } catch (_) {}
}

// Runtime state
let _openAiApiKeys = [];
let _currentOpenAiKeyIndex = 0;
let _openAiModel   = 'gpt-4o-mini';
let _geminiApiKey  = '';
let _ollamaBaseUrl = 'http://localhost:11434';
let _ollamaModel   = 'qwen2.5:7b';
let _geminiModel   = 'gemini-2.0-flash';
let _ollamaTimeout = 300000; // Increased to 5 mins default
let _useOpenAi     = true;
let _useGemini     = true;
let _useOllama     = true;
let _openAiClient  = null;   // lazy-loaded
let _geminiClient  = null;   // lazy-loaded

/**
 * Call once at startup to configure the provider from config.json / env.
 */
function initAIProvider(config = {}) {
  const key1 = process.env.OPENAI_API_KEY || config.openAiApiKey || '';
  const key2 = config.openAiApiKey2 || '';
  _openAiApiKeys = [key1, key2].filter(k => !!k);
  _currentOpenAiKeyIndex = 0;
  _openAiModel   = config.openAiModel     || 'gpt-4o-mini';
  _geminiApiKey  = process.env.GEMINI_API_KEY || config.geminiApiKey || '';
  _ollamaBaseUrl = config.ollamaBaseUrl || 'http://localhost:11434';
  _ollamaModel   = config.aiModel       || 'qwen2.5:7b';
  _geminiModel   = config.geminiModel   || 'gemini-2.0-flash';
  _ollamaTimeout = config.ollamaTimeout || 300000;
  _useOpenAi     = _openAiApiKeys.length > 0;
  _useGemini     = !!_geminiApiKey;
  _useOllama     = !config.skipAI;

  // Keep ollamaManager in sync so model switches are reflected immediately
  const mgr = _getOllamaManager();
  if (mgr) {
    mgr.baseUrl      = _ollamaBaseUrl;
    if (_ollamaModel) mgr.currentModel = _ollamaModel;
  }

  if (_useOpenAi) {
    logger.info(`[AIProvider] Primary: OpenAI (${_openAiModel})`);
  }
  if (_useGemini) {
    logger.info(`[AIProvider] ${_useOpenAi ? 'Secondary' : 'Primary'}: Google Gemini (${_geminiModel})`);
  } else if (!_useOpenAi) {
    logger.info('[AIProvider] OpenAI and Gemini disabled. Using Ollama only.');
  }
  if (_useOllama) {
    logger.info(`[AIProvider] Fallback: Ollama (${_ollamaModel} @ ${_ollamaBaseUrl}, timeout:${_ollamaTimeout}ms)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI caller
// ─────────────────────────────────────────────────────────────────────────────
async function _askOpenAI(prompt, opts = {}) {
  const currentKey = _openAiApiKeys[_currentOpenAiKeyIndex];
  if (!_openAiClient || _openAiClient.apiKey !== currentKey) {
    const { OpenAI } = require('openai');
    _openAiClient = new OpenAI({ apiKey: currentKey });
  }

  const response = await _openAiClient.chat.completions.create({
    model: _openAiModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? opts.num_predict ?? 500,
    top_p: opts.top_p ?? 0.95,
  });

  return response.choices[0]?.message?.content || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini caller
// ─────────────────────────────────────────────────────────────────────────────
async function _askGemini(prompt, opts = {}) {
  // Lazy-load to avoid crashing if package not installed
  if (!_geminiClient) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    _geminiClient = new GoogleGenerativeAI(_geminiApiKey);
  }

  const model = _geminiClient.getGenerativeModel({
    model: _geminiModel,
    generationConfig: {
      temperature:     opts.temperature   ?? 0.2,
      maxOutputTokens: opts.maxTokens     ?? opts.num_predict ?? 500,
      topP:            opts.top_p         ?? 0.95,
    },
  });

  const result = await model.generateContent(prompt);
  return result.response.text() || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama caller
// ─────────────────────────────────────────────────────────────────────────────
async function _askOllama(prompt, opts = {}) {
  // Always read live model from ollamaManager so dropdown switches take effect instantly
  const mgr = _getOllamaManager();
  const liveModel = (mgr && mgr.currentModel) ? mgr.currentModel : _ollamaModel;

  // Detect "thinking" models (qwen3, deepseek-r1) that use <think> blocks —
  // they need higher num_predict because reasoning tokens consume the budget
  // before the actual answer is generated.
  const isThinkingModel = /qwen3|deepseek-r1/i.test(liveModel);

  let numPredict = opts.num_predict ?? opts.maxTokens ?? 100;
  if (isThinkingModel && numPredict < 300) {
    numPredict = 300;  // enough for <think>…</think> + answer
  }

  // Context window: must be large enough to hold the full prompt + output.
  // 512 tokens truncates prompts > ~380 words, causing wrong or empty answers.
  // 2048 is a good balance between memory (~300 MiB KV-cache) and prompt capacity.
  const numCtx = opts.num_ctx ?? 2048;

  // For thinking models, prepend /no_think to short-answer prompts to skip
  // the expensive reasoning phase when the answer is brief (e.g. form fields).
  let effectivePrompt = prompt;
  if (isThinkingModel && numPredict <= 300) {
    effectivePrompt = '/no_think\n' + prompt;
  }

  logger.info(`[AIProvider] Sending prompt to ${liveModel}, length: ${prompt?.length}${isThinkingModel ? ' [thinking model]' : ''}`);
  logger.debug(`[AIProvider] Prompt preview: ${prompt?.substring(0, 150)}...`);

  const response = await axios.post(
    `${_ollamaBaseUrl}/api/generate`,
    {
      model:  liveModel,
      prompt: effectivePrompt,
      stream: false,
      options: {
        temperature: opts.temperature  ?? 0.2,
        top_p:       opts.top_p        ?? 0.95,
        num_predict: numPredict,
        num_ctx:     numCtx,
      },
    },
    { timeout: _ollamaTimeout, headers: { 'Content-Type': 'application/json' } }
  );

  const raw = response.data?.response || '';
  // deepseek-r1 emits <think>...</think> reasoning blocks — strip them out.
  // Also handle cases where generation stopped mid-thought (missing </think>)
  return raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: unified ask with auto-fallback
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Ask the AI a question. Tries Gemini first (if configured), then Ollama.
 * @param {string} prompt
 * @param {object} opts  - { temperature, maxTokens/num_predict, top_p }
 * @returns {Promise<string>} raw response text
 */
async function askAI(prompt, opts = {}) {
  const reqId = _shortId();

  // ── 0. Try OpenAI ──────────────────────────────────────────────────────
  if (_useOpenAi && _openAiApiKeys.length > 0) {
    let attempts = 0;
    while (attempts < 2 && _useOpenAi) {
      try {
        const logMsg = `[AIProvider:${reqId}] 🔵 OpenAI request (${_openAiModel}) [Key ${_currentOpenAiKeyIndex + 1}/${_openAiApiKeys.length}]`;
        logger.debug(logMsg);
        _emitLog('info', logMsg, { reqId, model: _openAiModel, provider: 'openai' });
        _logEmitter && _logEmitter('ai:query_start', { reqId, model: _openAiModel, provider: 'openai', ts: new Date().toISOString() });
        const start = Date.now();
        const response = await _askOpenAI(prompt, opts);
        const elapsedMs = Date.now() - start;
        const doneMsg = `[AIProvider:${reqId}] ✅ OpenAI responded in ${elapsedMs}ms`;
        logger.info(doneMsg);
        _emitLog('info', doneMsg, { reqId, model: _openAiModel, provider: 'openai', elapsedMs });
        _logEmitter && _logEmitter('ai:query_done', { reqId, model: _openAiModel, provider: 'openai', elapsedMs, ts: new Date().toISOString() });
        return response;
      } catch (err) {
        const status = err?.status;
        const msg = err?.message || '';
        const isQuotaError = status === 429 && (msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('exceeded'));
        
        if (isQuotaError || status === 401 || status === 403) {
          const warnMsg = `[AIProvider:${reqId}] ⚠️ OpenAI Key ${_currentOpenAiKeyIndex + 1} failed (${msg}).`;
          logger.warn(warnMsg);
          _emitLog('warn', warnMsg, { reqId, provider: 'openai' });
          if (_currentOpenAiKeyIndex + 1 < _openAiApiKeys.length) {
            logger.warn(`[AIProvider:${reqId}] Switching to next OpenAI key in config...`);
            _currentOpenAiKeyIndex++;
            continue; // Try next key immediately (does not increment attempts counter)
          } else {
            logger.warn(`[AIProvider:${reqId}] All OpenAI keys exhausted. Disabling OpenAI fallback.`);
            _useOpenAi = false;
            break;
          }
        }
        
        if (status === 429 && attempts === 0) {
          const rateMsg = `[AIProvider:${reqId}] ⏳ OpenAI rate limited (429) – waiting 5s then retrying...`;
          logger.warn(rateMsg);
          _emitLog('warn', rateMsg, { reqId, provider: 'openai' });
          await new Promise(r => setTimeout(r, 5000));
          attempts++;
          continue;
        }

        const fallMsg = `[AIProvider:${reqId}] ⚠️ OpenAI failed (${msg}) – falling back to next provider`;
        logger.warn(fallMsg);
        _emitLog('warn', fallMsg, { reqId, provider: 'openai' });
        break; // fall through to Gemini
      }
    }
  }

  // ── 1. Try Gemini ─────────────────────────────────────────────────────
  if (_useGemini && _geminiApiKey) {
    // Try up to 2 times: on rate limit wait 65s then retry once
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const logMsg = `[AIProvider:${reqId}] 🟡 Gemini request (${_geminiModel}) attempt ${attempt + 1}`;
        logger.debug(logMsg);
        _emitLog('info', logMsg, { reqId, model: _geminiModel, provider: 'gemini' });
        _logEmitter && _logEmitter('ai:query_start', { reqId, model: _geminiModel, provider: 'gemini', ts: new Date().toISOString() });
        const start = Date.now();
        const response = await _askGemini(prompt, opts);
        const elapsedMs = Date.now() - start;
        const doneMsg = `[AIProvider:${reqId}] ✅ Gemini responded in ${elapsedMs}ms`;
        logger.info(doneMsg);
        _emitLog('info', doneMsg, { reqId, model: _geminiModel, provider: 'gemini', elapsedMs });
        _logEmitter && _logEmitter('ai:query_done', { reqId, model: _geminiModel, provider: 'gemini', elapsedMs, ts: new Date().toISOString() });
        return response;
      } catch (err) {
        const status = err?.status || err?.response?.status;
        if (status === 429 && attempt === 0) {
          const rateMsg = `[AIProvider:${reqId}] ⏳ Gemini rate limited (429) – waiting 65s then retrying...`;
          logger.warn(rateMsg);
          _emitLog('warn', rateMsg, { reqId, provider: 'gemini' });
          await new Promise(r => setTimeout(r, 65000));
          continue; // retry
        }
        const reason = status === 401 ? 'invalid API key'
                     : status === 403 ? 'quota exceeded'
                     : status === 429 ? 'rate limited (retry failed)'
                     : err.message;
        const failMsg = `[AIProvider:${reqId}] ⚠️ Gemini failed (${reason}) – falling back to local model`;
        logger.warn(failMsg);
        _emitLog('warn', failMsg, { reqId, provider: 'gemini' });
        if (status === 401 || status === 403 || status === 429) {
          _useGemini = false;
          logger.warn(`[AIProvider:${reqId}] Gemini disabled for this session (status:${status})`);
        }
        break; // fall through to Ollama
      }
    }
  }

  // ── 2. Try Ollama ──────────────────────────────────────────────────────
  if (_useOllama) {
    try {
      const logMsg = `[AIProvider:${reqId}] 🟣 Ollama request (${_ollamaModel})…`;
      logger.debug(logMsg);
      _emitLog('info', logMsg, { reqId, model: _ollamaModel, provider: 'ollama' });
      _logEmitter && _logEmitter('ai:query_start', { reqId, model: _ollamaModel, provider: 'ollama', ts: new Date().toISOString() });
      const start = Date.now();
      const response = await _askOllama(prompt, opts);
      const elapsedMs = Date.now() - start;
      const doneMsg = `[AIProvider:${reqId}] ✅ Ollama (${_ollamaModel}) responded in ${(elapsedMs/1000).toFixed(2)}s`;
      logger.info(doneMsg);
      _emitLog('info', doneMsg, { reqId, model: _ollamaModel, provider: 'ollama', elapsedMs });
      _logEmitter && _logEmitter('ai:query_done', { reqId, model: _ollamaModel, provider: 'ollama', elapsedMs, ts: new Date().toISOString() });
      return response;
    } catch (err) {
      const isTimeout = err.code === 'ECONNABORTED' || err.message.includes('timeout');
      const errMsg = isTimeout
        ? `[AIProvider:${reqId}] ⏱️ Ollama TIMEOUT after ${_ollamaTimeout}ms`
        : `[AIProvider:${reqId}] ❌ Ollama failed: ${err.message}`;
      logger.error(errMsg);
      _emitLog('error', errMsg, { reqId, model: _ollamaModel, provider: 'ollama' });
      _logEmitter && _logEmitter('ai:query_done', { reqId, model: _ollamaModel, provider: 'ollama', elapsedMs: -1, error: err.message, ts: new Date().toISOString() });
    }
  }

  // ── 3. All providers failed ─────────────────────────────────────────────
  const critMsg = `[AIProvider:${reqId}] ❌ CRITICAL: All AI providers failed. Returning empty response.`;
  logger.error(critMsg);
  _emitLog('error', critMsg, { reqId });
  return '';
}

/**
 * Get active provider name (for logging/dashboard).
 */
function getProviderInfo() {
  const active = [];
  if (_useOpenAi && _openAiApiKeys.length > 0) active.push(`OpenAI (${_openAiModel})`);
  if (_useGemini && _geminiApiKey) active.push(`Gemini (${_geminiModel})`);
  if (_useOllama)                  active.push(`Ollama (${_ollamaModel})`);
  
  if (active.length > 0) return active.join(' → ');
  return 'keyword-only (no AI)';
}

module.exports = { initAIProvider, askAI, getProviderInfo, setLogEmitter };
