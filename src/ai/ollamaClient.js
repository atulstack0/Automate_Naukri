'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Shared low-level Ollama call — used by analyzeJob AND aiAgent.js
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Send a prompt to Ollama and return the raw response string.
 * @param {string} prompt
 * @param {object} opts - Ollama generation options (temperature, num_predict, etc.)
 * @param {object} connectionOpts - { baseUrl, model, timeoutMs }
 */
async function askOllama(prompt, opts = {}, connectionOpts = {}) {
  const {
    baseUrl  = process.env.OLLAMA_URL || 'http://localhost:11434',
    model    = process.env.OLLAMA_MODEL || 'qwen2.5:7b',
    timeoutMs = 120000,
  } = connectionOpts;

  logger.debug(`[Ollama] Requesting generation: model=${model}, temp=${opts.temperature ?? 0.15}`);
  const response = await axios.post(
    `${baseUrl}/api/generate`,
    {
      model,
      prompt,
      stream: false,
      options: {
        temperature:  opts.temperature  ?? 0.15,
        top_p:        opts.top_p        ?? 0.95,
        num_predict:  opts.num_predict  ?? 400,
        ...opts,
      },
    },
    { timeout: timeoutMs, headers: { 'Content-Type': 'application/json' } }
  );

  const rawRes = response.data?.response || '';
  logger.debug(`[Ollama] Raw response received (${rawRes.length} chars)`);
  return rawRes;
}



const PROMPT_TEMPLATE = (jobText, keywords) => `You are a job application AI assistant. Analyze the job description below and decide whether to APPLY or SKIP based on relevance to the candidate's profile.

Candidate profile keywords: ${keywords.join(', ')}

Job Description:
---
${jobText.substring(0, 3000)}
---

Respond with ONLY a valid JSON object (no markdown, no explanation, no extra text). Use this exact format:
{"decision":"APPLY","score":85,"reason":"matches keywords X and Y, good fit for candidate"}

Rules:
- decision must be exactly "APPLY" or "SKIP"
- score is an integer 0-100 indicating relevance
- reason is a short string under 120 characters
- If the job is unclear or missing details, return {"decision":"SKIP","score":20,"reason":"insufficient job details"}
- Do NOT include any text outside the JSON object`;

function parseAIResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    logger.warn('[Ollama] Received empty/invalid response string');
    return { decision: 'SKIP', score: 0, reason: 'empty AI response' };
  }
  
  // Try 1: Direct JSON parse
  try {
    const parsed = JSON.parse(raw.trim());
    logger.debug('[Ollama] Successfully parsed direct JSON');
    return normalizeAIResult(parsed);
  } catch (_) {
    logger.debug('[Ollama] Direct JSON parse failed, trying regex extraction...');
  }
 
  // Try 2: Extract JSON from markdown or text
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try { 
      const parsed = JSON.parse(jsonMatch[0]);
      logger.debug('[Ollama] Successfully extracted JSON via regex');
      return normalizeAIResult(parsed); 
    } catch (_) {
      logger.debug('[Ollama] Regex JSON extraction failed parsing');
    }
  }
 
  // Try 3: Heuristic extraction
  logger.warn('[Ollama] AI returned non-JSON – attempting heuristic parse', { raw: raw.substring(0, 200) });
  const decisionMatch = raw.match(/\b(APPLY|SKIP)\b/i);
  const scoreMatch    = raw.match(/\b(\d{1,3})\b/);
  const reasonMatch   = raw.match(/reason[:\s]+["']?([^"'\n]{5,120})/i);
 
  const result = {
    decision: decisionMatch ? decisionMatch[1].toUpperCase() : 'SKIP',
    score:    scoreMatch    ? Math.min(parseInt(scoreMatch[1], 10), 100) : 30,
    reason:   reasonMatch   ? reasonMatch[1].trim() : 'parsed from unstructured response',
  };
  logger.debug('[Ollama] Heuristic parse result', result);
  return result;
}

function normalizeAIResult(obj) {
  const decision = (obj.decision || 'SKIP').toUpperCase();
  const score    = Math.min(Math.max(parseInt(obj.score, 10) || 0, 0), 100);
  const reason   = (obj.reason || '').toString().substring(0, 200);
  return {
    decision: ['APPLY', 'SKIP'].includes(decision) ? decision : 'SKIP',
    score,
    reason,
  };
}

/**
 * Warm up Ollama by sending a tiny ping request.
 * This forces the model to load into RAM before the first real job request.
 * Retries up to maxWaitMs with exponential backoff.
 */
async function warmUpOllama(baseUrl, model, maxWaitMs = 180000) {
  const start = Date.now();
  let attempt = 0;

  logger.info(`Warming up Ollama (model: ${model}) – this may take 1-2 min for large models...`);

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await axios.post(
        `${baseUrl}/api/generate`,
        { model, prompt: 'Reply with the word READY only.', stream: false,
          options: { num_predict: 5, temperature: 0 } },
        { timeout: 120000, headers: { 'Content-Type': 'application/json' } }
      );
      const reply = (res.data?.response || '').trim();
      logger.info(`Ollama warm-up OK (attempt ${attempt + 1}): "${reply.substring(0, 30)}"`);
      return true;
    } catch (err) {
      attempt++;
      const delay = Math.min(5000 * attempt, 20000);
      logger.warn(`Ollama warm-up attempt ${attempt} failed – retrying in ${delay / 1000}s`, { err: err.message });
      await new Promise(r => setTimeout(r, delay));
    }
  }

  logger.error('Ollama did not respond within warm-up timeout – will proceed anyway, AI decisions may default to SKIP');
  return false;
}

/**
 * Local keyword scorer – used as fallback when Ollama is unavailable.
 * Scores the job text against required/preferred/excluded keywords.
 */
function localKeywordScore(jobText, keywords = {}) {
  const text   = (jobText || '').toLowerCase();
  const req    = (keywords.required  || []).map(k => k.toLowerCase());
  const pref   = (keywords.preferred || []).map(k => k.toLowerCase());
  const excl   = (keywords.excluded  || []).map(k => k.toLowerCase());

  // Instant skip if excluded keyword found
  for (const kw of excl) {
    if (text.includes(kw)) {
      return { decision: 'SKIP', score: 5, reason: `excluded keyword: "${kw}"` };
    }
  }

  let score = 0;
  const matched = [];

  for (const kw of req) {
    if (text.includes(kw)) { score += 15; matched.push(kw); }
  }
  for (const kw of pref) {
    if (text.includes(kw)) { score += 8; matched.push(kw); }
  }

  score = Math.min(score, 100);
  const decision = score >= 40 ? 'APPLY' : 'SKIP';
  const reason   = matched.length
    ? `keyword match: ${matched.slice(0, 4).join(', ')}`
    : 'no keyword matches';

  return { decision, score, reason };
}

/**
 * Analyse a job and return { decision, score, reason }.
 * Falls back to local keyword scoring if Ollama is unavailable.
 */
async function analyzeJob(jobText, config) {
  const {
    ollamaBaseUrl = 'http://localhost:11434',
    aiModel       = 'mistral',
    keywords      = { required: [], preferred: [] },
    skipAI        = false,
  } = config;

  // If skipAI mode: use local keyword scorer only
  if (skipAI) {
    logger.info('skipAI=true – using local keyword scorer');
    return localKeywordScore(jobText, keywords);
  }

  const allKeywords = [
    ...(keywords.required  || []),
    ...(keywords.preferred || []),
  ];

  logger.info(`Sending job to Ollama (model: ${aiModel})`);

  try {
    const response = await axios.post(
      `${ollamaBaseUrl}/api/generate`,
      {
        model:   aiModel,
        prompt:  PROMPT_TEMPLATE(jobText, allKeywords),
        stream:  false,
        options: { temperature: 0.1, top_p: 0.95, num_predict: 200 },
      },
      { timeout: 120000, headers: { 'Content-Type': 'application/json' } }
    );

    const raw = response.data?.response || '';
    logger.debug('Ollama raw response', { raw: raw.substring(0, 300) });

    const result = parseAIResponse(raw);
    logger.info('AI decision', result);
    return result;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      logger.error('Ollama not running at ' + ollamaBaseUrl + '. Start with: ollama serve');
    } else {
      logger.warn('Ollama request failed – falling back to keyword scorer', { message: err.message });
    }
    // Fallback: local keyword matcher so we still apply to relevant jobs
    const fallback = localKeywordScore(jobText, keywords);
    logger.info('Fallback keyword score', fallback);
    return fallback;
  }
}

module.exports = { askOllama, analyzeJob, parseAIResponse, warmUpOllama, localKeywordScore };

