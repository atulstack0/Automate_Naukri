'use strict';

/**
 * AutoApply — Ollama AI Client
 *
 * Provides two interfaces:
 *  1. OllamaClient class (spec API) — new OllamaClient({ model, baseUrl })
 *  2. Legacy function exports — askOllama, analyzeJob, warmUpOllama, etc.
 *     kept for backward compatibility with aiProvider.js / worker.js callers.
 */

const axios  = require('axios');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// OllamaClient class
// ─────────────────────────────────────────────────────────────────────────────

class OllamaClient {
  /**
   * @param {{ model: string, baseUrl?: string }} opts
   */
  constructor({ model, baseUrl = 'http://localhost:11434' } = {}) {
    this.model   = model   || process.env.OLLAMA_MODEL || 'mistral';
    this.baseUrl = baseUrl || process.env.OLLAMA_URL   || 'http://localhost:11434';
  }

  // ── Core completion ────────────────────────────────────────────────────────

  /**
   * Send a prompt and return the trimmed response string.
   * Retries up to 2x on failure with 2s delay.
   * @param {string} prompt
   * @param {number} timeoutMs
   * @returns {Promise<string>}
   */
  async complete(prompt, timeoutMs = 60000, opts = {}) {
    const maxRetries = 2;
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          logger.debug(`[Ollama] Retry attempt ${attempt}/${maxRetries}...`);
          await new Promise(r => setTimeout(r, 2000));
        }

        logger.info(`\n🔵 [OLLAMA] Sending request... (model: ${this.model}, attempt: ${attempt + 1})`);
        logger.debug(`📝 [PROMPT] ${prompt.substring(0, 300)}${prompt.length > 300 ? '...' : ''}`);
        const t0 = Date.now();

        const response = await axios.post(
          `${this.baseUrl}/api/generate`,
          { 
            model: this.model, 
            prompt, 
            stream: true,
            options: opts
          },
          { timeout: timeoutMs, headers: { 'Content-Type': 'application/json' }, responseType: 'stream' }
        );

        process.stdout.write("🤖 ");
        const text = await new Promise((resolve, reject) => {
          let fullText = '';
          let finalStats = {};

          response.data.on('data', chunk => {
            try {
              // Note: chunk can contain multiple JSON objects separated by newline
              const lines = chunk.toString().split('\n').filter(Boolean);
              for (const line of lines) {
                const json = JSON.parse(line);
                fullText += json.response;
                process.stdout.write(json.response);
                if (json.done) {
                  finalStats = json;
                }
              }
            } catch (e) {
              // ignore parse errors for partial chunks if they happen
            }
          });

          response.data.on('end', () => {
            process.stdout.write("\n");
            const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
            logger.info(''); // blank line after stream
            logger.info(`✅ [OLLAMA RESPONSE] (${elapsed}s) → ${fullText.substring(0, 150)}${fullText.length > 150 ? '...' : ''}`);
            logger.info(`📊 [OLLAMA STATS] model=${finalStats.model || this.model} | total=${((finalStats.total_duration || 0) / 1e9).toFixed(2)}s | load=${((finalStats.load_duration || 0) / 1e9).toFixed(2)}s | tokens=${finalStats.eval_count ?? '?'} | eval=${((finalStats.eval_duration || 0) / 1e9).toFixed(2)}s`);
            resolve(fullText.trim());
          });

          response.data.on('error', err => reject(err));
        });

        return text;
      } catch (err) {
        lastErr = err;
        logger.warn(`[Ollama] complete() attempt ${attempt} failed: ${err.message}`);
      }
    }

    throw lastErr;
  }

  /**
   * Complete a prompt expecting a JSON response.
   * Strips ```json ... ``` fences, then JSON.parse().
   * @param {string} prompt
   * @returns {Promise<object>}
   */
  async completeJSON(prompt, opts = { num_predict: 200, num_ctx: 3000, temperature: 0.1 }) {
    const raw = await this.complete(prompt, 120000, opts);

    // Strip ```json fences
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // Try direct parse
    try {
      return JSON.parse(cleaned);
    } catch (_) { /* fall through */ }

    // Try extracting first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) { /* fall through */ }
    }

    throw new Error('JSON parse failed');
  }

  // ── Job scoring ─────────────────────────────────────────────────────────────

  /**
   * Score a job against the candidate profile. Returns { score, decision, reason }.
   * On any error returns { score:0, decision:'SKIP', reason:'AI error' }.
   * @param {{ title, company, location, description, keywords, profile }} opts
   * @returns {Promise<{ score: number, decision: string, reason: string }>}
   */
  async scoreJob({ title, company, location, description, keywords = [], profile = {} }) {
    const prompt = `You are a job matching expert. Score this job.
Respond ONLY with JSON, no explanation.

CANDIDATE: Name=${profile.name || profile.currentRole || 'Candidate'}, Role=${profile.currentRole || profile.role || ''}, Skills=${(profile.skills || []).join(', ')}, Experience=${profile.yearsExperience || profile.experience || ''}
Required Keywords: ${keywords.join(', ')}

JOB: ${title} at ${company}, ${location || ''}
Description: ${(description || '').slice(0, 1500)}

Return: { "score": 0-100, "decision": "APPLY" or "SKIP", "reason": "one sentence" }
score>=60 = APPLY. Base on skill overlap, title match, seniority fit.`;

    try {
      const result = await this.completeJSON(prompt);
      return {
        score:    Math.min(Math.max(parseInt(result.score, 10) || 0, 0), 100),
        decision: (['APPLY', 'SKIP'].includes((result.decision || '').toUpperCase()))
                    ? result.decision.toUpperCase() : 'SKIP',
        reason:   (result.reason || '').toString().slice(0, 200),
      };
    } catch (err) {
      logger.warn(`[Ollama] scoreJob failed: ${err.message}`);
      return { score: 0, decision: 'SKIP', reason: 'AI error' };
    }
  }

  // ── Health check ────────────────────────────────────────────────────────────

  /**
   * Checks if Ollama is running by GETting the base URL.
   * @returns {Promise<boolean>}
   */
  async isOllamaRunning() {
    try {
      const res = await axios.get(this.baseUrl, { timeout: 5000 });
      return res.status === 200;
    } catch (_) {
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy low-level helper — used by aiProvider.js and analyzeJob()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a prompt to Ollama and return the raw response string.
 * @param {string} prompt
 * @param {object} opts  - Ollama generation options (temperature, num_predict, etc.)
 * @param {object} connectionOpts  - { baseUrl, model, timeoutMs }
 */
async function askOllama(prompt, opts = {}, connectionOpts = {}) {
  const {
    baseUrl   = process.env.OLLAMA_URL   || 'http://localhost:11434',
    model     = process.env.OLLAMA_MODEL || 'qwen2.5:7b',
    timeoutMs = 300000,
  } = connectionOpts;

  logger.info(`\n🔵 [OLLAMA] Sending request... (model: ${model})`);
  logger.debug(`📝 [PROMPT] ${prompt.substring(0, 300)}${prompt.length > 300 ? '...' : ''}`);
  const t0 = Date.now();

  const response = await axios.post(
    `${baseUrl}/api/generate`,
    {
      model,
      prompt,
      stream: true,
      options: {
        temperature: opts.temperature ?? 0.15,
        top_p:       opts.top_p       ?? 0.95,
        num_predict: opts.num_predict ?? 400,
        ...opts,
      },
    },
    { timeout: timeoutMs, headers: { 'Content-Type': 'application/json' }, responseType: 'stream' }
  );

  process.stdout.write("🤖 ");
  const rawRes = await new Promise((resolve, reject) => {
    let fullText = '';
    let finalStats = {};

    response.data.on('data', chunk => {
      try {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const json = JSON.parse(line);
          fullText += json.response;
          process.stdout.write(json.response);
          if (json.done) {
            finalStats = json;
          }
        }
      } catch (e) {
        // ignore incomplete JSON chunks
      }
    });

    response.data.on('end', () => {
      process.stdout.write("\n");
      const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
      logger.info(''); // blank line after stream
      logger.info(`✅ [OLLAMA RESPONSE] (${elapsed}s) → ${fullText.substring(0, 150)}${fullText.length > 150 ? '...' : ''}`);
      logger.info(`📊 [OLLAMA STATS] model=${finalStats.model || model} | total=${((finalStats.total_duration || 0) / 1e9).toFixed(2)}s | load=${((finalStats.load_duration || 0) / 1e9).toFixed(2)}s | tokens=${finalStats.eval_count ?? '?'} | eval=${((finalStats.eval_duration || 0) / 1e9).toFixed(2)}s`);
      resolve(fullText.trim());
    });

    response.data.on('error', err => reject(err));
  });

  return rawRes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy response parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function parseAIResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    logger.warn('[Ollama] Received empty/invalid response string');
    return { decision: 'SKIP', score: 0, reason: 'empty AI response' };
  }

  // Try 1: direct JSON parse
  try { return normalizeAIResult(JSON.parse(raw.trim())); } catch (_) {}

  // Try 2: extract {...} block
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try { return normalizeAIResult(JSON.parse(jsonMatch[0])); } catch (_) {}
  }

  // Try 3: heuristic extraction
  logger.warn('[Ollama] Non-JSON response — heuristic parse', { raw: raw.substring(0, 200) });
  return {
    decision: (raw.match(/\b(APPLY|SKIP)\b/i)?.[1] || 'SKIP').toUpperCase(),
    score:    Math.min(parseInt(raw.match(/\b(\d{1,3})\b/)?.[1] || '30', 10), 100),
    reason:   raw.match(/reason[:\s]+"?([^"\n]{5,120})/i)?.[1]?.trim() || 'parsed from unstructured response',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy keyword scorer — fallback when Ollama unavailable
// ─────────────────────────────────────────────────────────────────────────────

function localKeywordScore(jobText, keywords = {}) {
  const text = (jobText || '').toLowerCase();
  const req  = (keywords.required  || []).map(k => k.toLowerCase());
  const pref = (keywords.preferred || []).map(k => k.toLowerCase());
  const excl = (keywords.excluded  || []).map(k => k.toLowerCase());

  for (const kw of excl) {
    if (text.includes(kw)) return { decision: 'SKIP', score: 5, reason: `excluded keyword: "${kw}"` };
  }

  let score = 0;
  const matched = [];
  for (const kw of req)  { if (text.includes(kw)) { score += 15; matched.push(kw); } }
  for (const kw of pref) { if (text.includes(kw)) { score += 8;  matched.push(kw); } }

  score = Math.min(score, 100);
  return {
    decision: score >= 40 ? 'APPLY' : 'SKIP',
    score,
    reason: matched.length ? `keyword match: ${matched.slice(0, 4).join(', ')}` : 'no keyword matches',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy warm-up — used by index.js at startup
// ─────────────────────────────────────────────────────────────────────────────

async function warmUpOllama(baseUrl, model, maxWaitMs = 180000) {
  const start = Date.now();
  let attempt = 0;
  logger.info(`Warming up Ollama (model: ${model})...`);
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await axios.post(
        `${baseUrl}/api/generate`,
        { model, prompt: 'Reply with the word READY only.', stream: false,
          options: { num_predict: 5, temperature: 0 } },
        { timeout: 300000 }
      );
      logger.info(`Ollama warm-up OK (attempt ${attempt + 1}): "${(res.data?.response || '').trim().substring(0, 30)}"`);
      return true;
    } catch (err) {
      attempt++;
      const delay = Math.min(5000 * attempt, 20000);
      logger.warn(`Ollama warm-up attempt ${attempt} failed – retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  logger.error('Ollama did not respond within warm-up timeout');
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy analyzeJob — used by worker.js
// ─────────────────────────────────────────────────────────────────────────────

const PROMPT_TEMPLATE = (jobText, keywords, profile) =>
  `You are a strict, highly discerning job application AI assistant. Analyze the job description below and decide whether to APPLY or SKIP based on strict relevance to the candidate's profile.

Candidate Profile Summary: ${profile.summary || 'N/A'}
Current Role: ${profile.currentRole || 'N/A'}
Years of Experience: ${profile.yearsExperience || 'N/A'}
Target Keywords: ${keywords.join(', ')}

Job Description:
---
${jobText.substring(0, 1500)}
---

Respond with ONLY a valid JSON object (no markdown, no explanation, no extra text). Use this exact format:
{"decision":"APPLY","score":85,"reason":"matches keywords X and Y, align with experience"}

Strict Rules:
1. decision MUST be exactly "APPLY" or "SKIP".
2. score is an integer 0-100.
3. reason is a short string under 120 characters.
4. IMPORTANT: If the job explicitly requires significantly more experience than the candidate has, you MUST return {"decision":"SKIP","score":10,"reason":"requires too much experience"}.
5. IMPORTANT: If the core tech stack or primary responsibilities do not strongly align with the candidate's summary and keywords, you MUST return "SKIP".
6. If the job is unclear or missing details, return {"decision":"SKIP","score":20,"reason":"insufficient job details"}.
7. Do NOT include any text outside the JSON object.`;

async function analyzeJob(jobText, config) {
  const {
    ollamaBaseUrl = 'http://localhost:11434',
    aiModel       = 'mistral',
    keywords      = { required: [], preferred: [] },
    skipAI        = false,
    profile       = {},
  } = config;

  if (skipAI) {
    logger.info('skipAI=true – using local keyword scorer');
    return localKeywordScore(jobText, keywords);
  }

  const allKeywords = [...(keywords.required || []), ...(keywords.preferred || [])];
  logger.info(`Analyzing job description (model: ${aiModel})...`);
  const { askAI } = require('./aiProvider');

  try {
    const raw = await askAI(PROMPT_TEMPLATE(jobText, allKeywords, profile), {
      temperature: 0.1, top_p: 0.95, num_predict: 200,
    });

    if (!raw) {
      logger.warn('[Ollama] AI returned empty – keyword fallback');
      return localKeywordScore(jobText, keywords);
    }

    const result = parseAIResponse(raw);

    if (result.decision === 'SKIP' && result.score === 0) {
      const kwResult = localKeywordScore(jobText, keywords);
      if (kwResult.decision === 'APPLY') {
        logger.info('[Ollama] Keyword scorer overruled AI SKIP', kwResult);
        return kwResult;
      }
    }

    logger.info('AI decision', result);
    return result;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      logger.error('Ollama not running at ' + ollamaBaseUrl + '. Start with: ollama serve');
    } else {
      logger.warn('Ollama request failed – keyword fallback', { message: err.message });
    }
    const fallback = localKeywordScore(jobText, keywords);
    logger.info('Fallback keyword score', fallback);
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // ── Spec class (primary API) ──
  OllamaClient,

  // ── Legacy function exports (backward compat) ──
  askOllama,
  analyzeJob,
  parseAIResponse,
  warmUpOllama,
  localKeywordScore,
};
