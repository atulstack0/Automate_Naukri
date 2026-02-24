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
let _geminiApiKey  = '';
let _ollamaBaseUrl = 'http://localhost:11434';
let _ollamaModel   = 'qwen2.5:7b';
let _geminiModel   = 'gemini-2.0-flash';
let _useGemini     = true;
let _useOllama     = true;
let _geminiClient  = null;   // lazy-loaded

/**
 * Call once at startup to configure the provider from config.json / env.
 */
function initAIProvider(config = {}) {
  _geminiApiKey  = process.env.GEMINI_API_KEY || config.geminiApiKey || '';
  _ollamaBaseUrl = config.ollamaBaseUrl || 'http://localhost:11434';
  _ollamaModel   = config.aiModel       || 'qwen2.5:7b';
  _geminiModel   = config.geminiModel   || 'gemini-2.0-flash';
  _useGemini     = !!_geminiApiKey;
  _useOllama     = !config.skipAI;

  if (_useGemini) {
    logger.info(`[AIProvider] Primary: Google Gemini (${_geminiModel})`);
  } else {
    logger.info('[AIProvider] Gemini disabled (no GEMINI_API_KEY). Using Ollama only.');
  }
  if (_useOllama) {
    logger.info(`[AIProvider] Fallback: Ollama (${_ollamaModel} @ ${_ollamaBaseUrl})`);
  }
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
  const response = await axios.post(
    `${_ollamaBaseUrl}/api/generate`,
    {
      model:  _ollamaModel,
      prompt,
      stream: false,
      options: {
        temperature: opts.temperature  ?? 0.2,
        top_p:       opts.top_p        ?? 0.95,
        num_predict: opts.num_predict  ?? opts.maxTokens ?? 500,
      },
    },
    { timeout: 120000, headers: { 'Content-Type': 'application/json' } }
  );
  return response.data?.response || '';
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
        if (status === 401 || status === 403) {
          _useGemini = false;
          logger.warn('[AIProvider] Gemini disabled for this session');
        }
        break; // fall through to Ollama
      }
    }
  }

  // ── 2. Try Ollama ──────────────────────────────────────────────────────
  if (_useOllama) {
    try {
      logger.debug(`[AIProvider] Fallback: Ollama (${_ollamaModel})`);
      const start = Date.now();
      const response = await _askOllama(prompt, opts);
      logger.info(`[AIProvider] Ollama response received in ${Date.now() - start}ms`);
      return response;
    } catch (err) {
      logger.error(`[AIProvider] Ollama fallback failed: ${err.message}`);
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
  if (_useGemini && _geminiApiKey) return `Gemini (${_geminiModel}) → Ollama fallback`;
  if (_useOllama)                  return `Ollama (${_ollamaModel})`;
  return 'keyword-only (no AI)';
}

module.exports = { initAIProvider, askAI, getProviderInfo };
