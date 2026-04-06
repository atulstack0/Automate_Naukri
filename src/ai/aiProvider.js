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
  // For deepseek models, we need higher minimum predict tokens so it can finish <think> 
  // Ensure numPredict isn't forcing models to generate endlessly when evaluating yes/no forms
  let numPredict = opts.num_predict ?? opts.maxTokens ?? 100;

  logger.info(`[AIProvider] Sending prompt to ${_ollamaModel}, length: ${prompt?.length}`);
  logger.debug(`[AIProvider] Prompt preview: ${prompt?.substring(0, 150)}...`);

  const response = await axios.post(
    `${_ollamaBaseUrl}/api/generate`,
    {
      model:  _ollamaModel,
      prompt,
      stream: false,
      options: {
        temperature: opts.temperature  ?? 0.2,
        top_p:       opts.top_p        ?? 0.95,
        num_predict: numPredict,
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
  // ── 0. Try OpenAI ──────────────────────────────────────────────────────
  if (_useOpenAi && _openAiApiKeys.length > 0) {
    let attempts = 0;
    while (attempts < 2 && _useOpenAi) {
      try {
        logger.debug(`[AIProvider] Attempt ${attempts + 1}: OpenAI (${_openAiModel}) [Key ${_currentOpenAiKeyIndex + 1}/${_openAiApiKeys.length}]`);
        const start = Date.now();
        const response = await _askOpenAI(prompt, opts);
        logger.info(`[AIProvider] OpenAI response received in ${Date.now() - start}ms`);
        return response;
      } catch (err) {
        const status = err?.status;
        const msg = err?.message || '';
        const isQuotaError = status === 429 && (msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('exceeded'));
        
        if (isQuotaError || status === 401 || status === 403) {
          logger.warn(`[AIProvider] OpenAI Key ${_currentOpenAiKeyIndex + 1} failed (${msg}).`);
          if (_currentOpenAiKeyIndex + 1 < _openAiApiKeys.length) {
            logger.warn(`[AIProvider] Switching to next OpenAI key in config...`);
            _currentOpenAiKeyIndex++;
            continue; // Try next key immediately (does not increment attempts counter)
          } else {
            logger.warn(`[AIProvider] All OpenAI keys exhausted. Disabling OpenAI fallback.`);
            _useOpenAi = false;
            break;
          }
        }
        
        if (status === 429 && attempts === 0) {
          logger.warn('[AIProvider] OpenAI rate limited (429) – waiting 5s then retrying...');
          await new Promise(r => setTimeout(r, 5000));
          attempts++;
          continue;
        }

        logger.warn(`[AIProvider] OpenAI failed (${msg}) – falling back to next provider`);
        break; // fall through to Gemini
      }
    }
  }

  // ── 1. Try Gemini ─────────────────────────────────────────────────────
  if (_useGemini && _geminiApiKey) {
    // Try up to 2 times: on rate limit wait 65s then retry once
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        logger.debug(`[AIProvider] Attempt ${attempt + 1}: Gemini (${_geminiModel})`);
        const start = Date.now();
        const response = await _askGemini(prompt, opts);
        logger.info(`[AIProvider] Gemini response received in ${Date.now() - start}ms`);
        return response;
      } catch (err) {
        const status = err?.status || err?.response?.status;
        if (status === 429 && attempt === 0) {
          logger.warn('[AIProvider] Gemini rate limited (429) – waiting 65s then retrying...');
          await new Promise(r => setTimeout(r, 65000));
          continue; // retry
        }
        const reason = status === 401 ? 'invalid API key'
                     : status === 403 ? 'quota exceeded'
                     : status === 429 ? 'rate limited (retry failed)'
                     : err.message;
        
        logger.warn(`[AIProvider] Gemini failed (${reason}) – falling back to local model`);
        if (status === 401 || status === 403 || status === 429) {
          _useGemini = false;
          logger.warn(`[AIProvider] Gemini disabled for this session (status:${status})`);
        }
        break; // fall through to Ollama
      }
    }
  }

  // ── 2. Try Ollama ──────────────────────────────────────────────────────
  if (_useOllama) {
    try {
      logger.debug(`[AIProvider] Fallback: Ollama (${_ollamaModel}) ...`);
      const start = Date.now();
      const response = await _askOllama(prompt, opts);
      logger.info(`[AIProvider] Ollama response received in ${Date.now() - start}ms`);
      return response;
    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
        logger.error(`[AIProvider] Ollama TIMEOUT after ${_ollamaTimeout}ms`);
      } else {
        logger.error(`[AIProvider] Ollama failed: ${err.message}`);
      }
    }
  }

  // ── 3. Both failed ─────────────────────────────────────────────────────
  logger.error('[AIProvider] CRITICAL: All AI providers failed');
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

module.exports = { initAIProvider, askAI, getProviderInfo };
