'use strict';

/**
 * aiAgent.js
 *
 * The AI brain for autonomous job application.
 * Answer pipeline (fastest → slowest):
 *  1. Exact DB match                  — instant, no AI
 *  2. Resume profile keyword match    — instant, no AI (resumeCache.js)
 *  3. AI model (Gemini → Ollama)      — only for truly unknown questions
 *
 * Self-learn: any question not in DB is recorded, answered by AI, saved back.
 */

const { askAI } = require('./aiProvider');
const { findFromProfile } = require('./resumeCache');
const logger = require('../utils/logger');
const db = require('../db/db');

// ── Learning Map Cache (refresh every 30s to avoid DB round-trips per field) ──
let _llCache = null;
let _llCacheTs = 0;
const LL_CACHE_TTL = 30_000; // 30 seconds

// ── AI Cooldown State ──
let _consecutiveAiFailures = 0;
const MAX_AI_FAILURES = 3;
const AI_COOLDOWN_MS = 300_000; // 5 minutes
let _aiCooldownUntil = 0;

function _getLearningMap() {
  const now = Date.now();
  if (_llCache && (now - _llCacheTs) < LL_CACHE_TTL) return _llCache;
  try {
    _llCache  = db.getAllAnsweredAsMap();
    _llCacheTs = now;
  } catch (_) { _llCache = {}; }
  return _llCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Answer any form field question
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Answer a single form field with a 3-tier fast path.
 */
async function answerField(question, fieldType = 'text', options = [], profile = {}, hint = '', sourceJobId = null, rejectedValue = '') {

  // ── Tier 1: Exact DB match ─────────────────────────────────────────────────
  try {
    const exact = db.findAnswerByQuestion(question);
    if (exact && !hint) {
      logger.info(`[Learning] Exact match: "${question.substring(0, 55)}" → "${exact}"`);
      console.log(`\nQ: ${question}\nA: ${exact}\n  ↳ [Exact DB match — no AI needed]`);
      return _matchOption(exact, options);
    }
  } catch (_) {}

  // ── Tier 2: Profile keyword match (resumeCache) — no AI needed ──────────────
  const ll = _getLearningMap();
  const profileAnswer = findFromProfile(question, ll);
  if (profileAnswer && !hint) {
    console.log(`\nQ: ${question}\nA: ${profileAnswer}\n  ↳ [Profile match — no AI needed]`);
    // Auto-save this to DB so next time it's Tier 1
    try {
      db.recordUnknownQuestion(question, fieldType, options, sourceJobId);
      const id = db.findAnswerByQuestion(question) ? null : db.recordUnknownQuestion(question, fieldType, options, sourceJobId);
      if (id) db.updateLearningAnswer(id, profileAnswer);
    } catch (_) {}
    return _matchOption(profileAnswer, options);
  }

  // ── Tier 3: AI (Gemini → Ollama) ──────────────────────────────────────────
  const now = Date.now();
  if (now < _aiCooldownUntil) {
    logger.warn(`[AIAgent] AI Cooldown active (until ${new Date(_aiCooldownUntil).toLocaleTimeString()}). Skipping Tier-3.`);
    return await _selfLearnAndSave(question, fieldType, options, sourceJobId);
  }

  const contextRows = db.getAllAnsweringContext(20);
  const fullContext = contextRows || 'No additional context yet.';

  logger.debug(`[AIAgent] Tier-3 AI call: ${Object.keys(ll).length} profile fields, context items: ${contextRows ? contextRows.split('\n---\n').length : 0}`);

  const profileSummary = _buildProfileSummary(ll, profile, fullContext);
  const optionsList    = options.length
    ? `\nAvailable options (choose one exactly): ${options.join(' | ')}`
    : '';

  const prompt = `You are a professional assistant filling out a job application for a candidate. 
CRITICAL RULE: Your answers MUST be perfectly consistent with the candidate's resume/profile provided below. 
Do NOT invent information. If the information is not explicitly in the profile, provide the most professional answer that aligns with a "QA Lead/Lead Automation Engineer" persona.

${profileSummary}

${hint ? `!!! ATTENTION - VALIDATION ERROR !!!
The previous attempt was REJECTED by the form with this error: "${hint}". 
The REJECTED value was: "${rejectedValue}". 
Please RE-EVALUATE the profile and the requirements to provide a CORRECT answer that will pass validation. 
For number fields, ensure you use the correct format (e.g., if it asks for a decimal, use 3.0 instead of 3).` : ''}

Question: "${question}"
Type: ${fieldType}${optionsList}
Rule: Reply with ONLY the answer value. Conciseness is mandatory. No conversational filler.
CRITICAL: If the question asks for years of experience or a number, provide ONLY the digits (e.g., "3" instead of "3 years").
Answer:`;


  try {
    const raw    = await askAI(prompt, { temperature: 0.1, num_predict: 80 });
    let answer = (raw || '').trim();
    
    // Strip conversational filler often produced by Llama 3 models
    answer = answer.replace(/^(here is the answer|the answer is|my answer is|based on the resume,?)[:\-\s]*/i, '');
    answer = answer.replace(/^["'\s]+|["'\s]+$/g, '');
    
    // ── Post-Processing: Strict Numeric Cleaning ─────────────────────────────
    if (fieldType === 'number' || /number|numeric|whole number/i.test(hint || question)) {
      // 1. Aggressive stripping of common conversational units
      answer = answer.replace(/years?|months?|yrs?|mos?|experience|exp/gi, '').trim();

      // 2. Extract first sequence of digits (and optional decimal)
      const numericMatch = answer.match(/\d+(\.\d+)?/);
      if (numericMatch) {
        let cleaned = numericMatch[0];
        
        // 3. Round to whole number if required
        if (/whole number|integer/i.test(hint || question)) {
          cleaned = String(Math.round(parseFloat(cleaned)));
        }

        if (cleaned !== answer) {
          logger.info(`[AI] Cleaned numeric answer: "${answer}" → "${cleaned}"`);
          answer = cleaned;
        }
      } else {
        // 4. Default to 0 for numeric fields if AI returns non-numeric garbage (e.g., "None", "No")
        if (/how many years|how much|experience/i.test(question)) {
           logger.warn(`[AI] Numeric extraction failed for "${answer}". Defaulting to "0".`);
           answer = "0";
        }
      }
    }

    _consecutiveAiFailures = 0; // Success! Reset counter
    _aiCooldownUntil = 0;

    logger.info(`[AI] "${question.substring(0, 50)}" → "${answer.substring(0, 60)}"`);

    if (!answer) {
      return await _selfLearnAndSave(question, fieldType, options, sourceJobId);
    }

    console.log(`\nQ: ${question}\nA: ${answer}\n  ↳ [AI answered]`);

    // Auto-save to DB for future use
    try {
      const rowId = db.recordUnknownQuestion(question, fieldType, options, sourceJobId);
      if (rowId) db.updateLearningAnswer(rowId, answer);
    } catch (_) {}

    return _matchOption(answer, options);
  } catch (err) {
    _consecutiveAiFailures++;
    logger.warn(`[AI] answerField failed (failure #${_consecutiveAiFailures}): ${err.message}`);
    
    if (_consecutiveAiFailures >= MAX_AI_FAILURES) {
      _aiCooldownUntil = Date.now() + AI_COOLDOWN_MS;
      logger.error(`[AI] Too many failures. Activating AI cooldown for 5 minutes.`);
    }

    return await _selfLearnAndSave(question, fieldType, options, sourceJobId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _matchOption(answer, options) {
  if (!options.length || !answer) return answer;
  const exact   = options.find(o => o.toLowerCase() === answer.toLowerCase());
  const partial  = options.find(o =>
    o.toLowerCase().includes(answer.toLowerCase()) ||
    answer.toLowerCase().includes(o.toLowerCase())
  );
  return exact || partial || options[0] || answer;
}

function _buildProfileSummary(ll, profile, fullContext) {
  return `### CANDIDATE PROFILE ###
- Name: ${profile.name || ll.name || 'Candidate'}
- Email: ${profile.email || ll.email || ''}
- Phone: ${profile.phone || ll.phone || ''}
- Location: ${profile.currentLocation || ll.city || ll.currentLocation || ''}
- Current Role: ${profile.currentRole || ll.currentRole || ''} at ${profile.currentCompany || ll.currentCompany || ''}
- Experience: ${profile.yearsExperience || ll.yearsExperience || ll.experience || '0'} years
- Notice Period: ${profile.noticePeriod || ll.notice || ''}
- Salary: ${profile.salary || ll.salary || ll.expectedCTC || ''}
- Skills: ${(ll.tools || profile.summary || '').substring(0, 150)}
- Languages: ${(ll.languages || '').substring(0, 80)}
- Education: ${profile.education || ll.qualification || ''}
- LinkedIn: ${profile.linkedIn || ll.linkedIn || ''}
- Portfolio: ${profile.portfolio || ll.portfolio || ''}
- GitHub: ${profile.github || ll.github || ''}

Summary: ${(profile.summary || '').substring(0, 200)}`.trim();
}

async function _selfLearnAndSave(question, fieldType, options, sourceJobId) {
  try {
    const learnedId = db.recordUnknownQuestion(question, fieldType, options, sourceJobId);
    const guessed   = await selfLearnAnswer(question, fieldType, options);
    if (guessed) {
      if (learnedId) db.updateLearningAnswer(learnedId, guessed);
      console.log(`\nQ: ${question}\nA: ${guessed}\n  ↳ [Self-learned and saved to DB]`);
      return guessed;
    }
  } catch (_) {}
  console.log(`\nQ: ${question}\nA: (unable to answer)\n  ↳ [Added to learning list for review]`);
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Self-learn: AI answer for unknown question, saved to DB
// ─────────────────────────────────────────────────────────────────────────────
async function selfLearnAnswer(question, fieldType = 'text', options = []) {
  const ll = _getLearningMap();
  const optionsList = options.length
    ? `Choices (pick one): ${options.join(' | ')}`
    : '';

  const prompt = `You are helping a job applicant answer a form question. Answer correctly and concisely.

Applicant: ${ll.name || 'Candidate'} | ${ll.currentRole || 'Professional'} at ${ll.currentCompany || 'Current Company'} | ${ll.yearsExperience || '0'} yrs | ${ll.city || ll.currentLocation || 'Location'}
Skills: ${ll.tools || 'See profile'}
Salary: ${ll.salary || ll.expectedCTC || 'Negotiable'} | Notice: ${ll.noticePeriod || '30 days'} | Relocate: ${ll.relocation || 'Yes'}

Question: "${question}"
Type: ${fieldType}
${optionsList}

Rules:
- Reply with ONLY the answer value, nothing else
- Must provide an answer — never say "I cannot"
- For yes/no: answer Yes unless inappropriate
- For number: provide just the number
${options.length ? '- Must match one of the listed choices' : ''}

Answer:`;

  const now = Date.now();
  if (now < _aiCooldownUntil) {
    logger.warn(`[SelfLearn] AI Cooldown active. Skipping AI Tier.`);
    return '';
  }

  try {
    const raw    = await askAI(prompt, { temperature: 0.3, num_predict: 80 });
    const answer = (raw || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
    if (!answer || /cannot|unable|don't know/i.test(answer)) return '';
    logger.info(`[SelfLearn] "${question.substring(0, 45)}" → "${answer.substring(0, 40)}"`);
    if (options.length) return _matchOption(answer, options);
    return answer;
  } catch (err) {
    logger.warn(`[SelfLearn] failed: ${err.message}`);
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1c. Batch self-learn cycle: auto-answer all pending unanswered questions
// ─────────────────────────────────────────────────────────────────────────────
async function runSelfLearnCycle() {
  const config = require('../../config/config.json');
  if (config.skipAI) {
    logger.info(`[SelfLearn] Skipping self-learn cycle: skipAI is true`);
    return { processed: 0, answered: 0 };
  }

  const pending = db.getLearningQuestions(500).filter(r => !r.answered);
  logger.info(`[SelfLearn] Cycle start: ${pending.length} unanswered`);

  let answeredCount = 0;
  for (const row of pending) {
    try {
      let opts = [];
      try { opts = JSON.parse(row.options || '[]'); } catch (_) {}

      // Fast path: try profile first
      const ll = _getLearningMap();
      const profileAnswer = findFromProfile(row.question, ll);
      if (profileAnswer) {
        db.updateLearningAnswer(row.id, profileAnswer);
        answeredCount++;
        logger.info(`[SelfLearn] Profile-answered id=${row.id}: "${profileAnswer}"`);
        continue;
      }

      // AI fallback
      const answer = await selfLearnAnswer(row.question, row.field_type, opts);
      if (answer) {
        db.updateLearningAnswer(row.id, answer);
        answeredCount++;
        logger.info(`[SelfLearn] AI-answered id=${row.id}: "${answer}"`);
      }
    } catch (err) {
      logger.warn(`[SelfLearn] Failed id=${row.id}: ${err.message}`);
    }
  }

  _llCache = null; // Invalidate cache after cycle
  logger.info(`[SelfLearn] Cycle done: ${answeredCount}/${pending.length}`);
  return { processed: pending.length, answered: answeredCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Decide next click action
// ─────────────────────────────────────────────────────────────────────────────
async function decideNextAction(pageText, goal = 'complete job application') {
  const prompt = `You are a browser automation agent navigating a job application page.

Goal: ${goal}

Page content (visible text):
---
${pageText.substring(0, 2500)}
---

Decide the SINGLE best next action. Reply with ONLY valid JSON, no extra text:
{"action":"click","target":"exact button or link text","reason":"short reason"}

Rules:
- action: "click", "skip" (done/submitted), or "wait"
- Prefer: Submit, Apply, Next, Continue, Save & Continue, Proceed, Send Application
- If success/thank-you visible: {"action":"skip","target":"","reason":"already submitted"}
- If CAPTCHA visible: {"action":"wait","target":"captcha","reason":"manual intervention needed"}`;

  try {
    const raw       = await askAI(prompt, { temperature: 0.1, num_predict: 100 });
    const jsonMatch = (raw || '').match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      logger.info(`[AI] Next action: ${result.action} → "${result.target}" (${result.reason})`);
      return result;
    }
  } catch (err) {
    logger.warn(`[AI] decideNextAction failed: ${err.message}`);
  }
  return { action: 'skip', target: '', reason: 'AI could not determine next action' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Detect if application was submitted successfully
// ─────────────────────────────────────────────────────────────────────────────
async function isApplicationComplete(pageText) {
  const prompt = `Does the following page content confirm a job application was SUCCESSFULLY submitted?

---
${pageText.substring(0, 1500)}
---

Reply with ONE word only: YES or NO`;

  try {
    const raw = await askAI(prompt, { temperature: 0, num_predict: 5 });
    const yes = /\byes\b/i.test(raw || '');
    logger.info(`[AI] isApplicationComplete: ${yes ? 'YES ✅' : 'NO'}`);
    return yes;
  } catch (err) {
    logger.warn(`[AI] isApplicationComplete failed: ${err.message}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Batch form analysis (one AI call for whole form)
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeFormAndAnswer(formText, profile = {}) {
  const ll          = _getLearningMap();
  const fullContext = db.getAllAnsweringContext(15);

  const profileSummary = _buildProfileSummary(ll, profile, fullContext || 'No history.');

  const prompt = `Analyze this job application form and return answers for all visible questions.

${profileSummary}

Form Content:
---
${formText.substring(0, 2500)}
---

Reply with ONLY a JSON array, nothing else:
[
  {"label": "field label", "answer": "value"},
  ...
]

Rules:
- Include only input fields (not buttons)
- yes/no → "Yes" or "No"
- number fields → just the number
- salary → "10 LPA" or "1000000"
- max 20 entries`;

  try {
    const raw       = await askAI(prompt, { temperature: 0.1, num_predict: 600 });
    const jsonMatch = (raw || '').match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const results = JSON.parse(jsonMatch[0]);
      logger.info(`[AI] Form analysis: ${results.length} answers`);
      return Array.isArray(results) ? results : [];
    }
  } catch (err) {
    logger.warn(`[AI] analyzeFormAndAnswer failed: ${err.message}`);
  }
  return [];
}

module.exports = {
  answerField,
  decideNextAction,
  isApplicationComplete,
  analyzeFormAndAnswer,
  selfLearnAnswer,
  runSelfLearnCycle,
  askAI,
};
