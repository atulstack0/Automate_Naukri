'use strict';

/**
 * aiAgent.js
 *
 * The AI brain for autonomous job application.
 * Uses Ollama (qwen2.5:7b) to reason about:
 *  1. How to answer any form question
 *  2. What to click next on a page
 *  3. Whether an application was submitted
 *  4. Whether to apply or skip a job (enhanced)
 */

const { askAI } = require('./aiProvider');
const logger = require('../utils/logger');
const db = require('../db/db');


// ─────────────────────────────────────────────────────────────────────────────
// 1. Answer any form field question
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask the AI to answer a single form field.
 * @param {string} question  - The field label / question text
 * @param {string} fieldType - 'text' | 'select' | 'radio' | 'checkbox' | 'textarea'
 * @param {string[]} options - Available options (for dropdowns/radios)
 * @param {object} profile   - Candidate profile from config
 * @param {string} hint      - Extra context (page title, job title, etc.)
 * @returns {Promise<string>} - The best answer to type/select
 */
async function answerField(question, fieldType = 'text', options = [], profile = {}, hint = '', sourceJobId = null) {
  // ── Step 1: Check learning list for an EXACT previously-saved answer ──
  try {
    const exact = db.findAnswerByQuestion(question);
    if (exact) {
      logger.info(`[Learning] Using exact match for "${question.substring(0, 60)}" → "${exact}"`);
      console.log(`\nQuestion: ${question}\nResponse: ${exact}\n  ↳ Answered using an exact-match learned response.`);
      return exact;
    }
  } catch (_) { /* non-fatal – fall through to AI */ }

  // ── Step 2: Use AI to answer based on full Learning List & Profile ──
  const ll = db.getAllAnsweredAsMap();
  const contextRows = db.getAllAnsweringContext(30);
  const fullContext = contextRows || 'No additional context yet.';
  
  logger.debug(`[AIAgent] Building answer context: ${Object.keys(ll).length} profile fields, ${contextRows.split('\n---\n').length} history items`);

  const profileSummary = `
Candidate profile:
- Name: ${ll.name || profile.name || 'Atul Patil'}
- Email: ${ll.email || profile.email || ''}
- Phone: ${ll.phone || profile.phone || ''}
- Location: ${ll.location || ll.currentLocation || profile.location || 'Pune, India'}
- Current role: ${ll.currentRole || profile.currentRole || 'QA Lead'}
- Current company: ${ll.currentCompany || profile.currentCompany || 'Chat360'}
- Years of experience: ${ll.experience || ll.yearsExperience || profile.yearsOfExperience || '3'}
- Notice period: ${ll.notice || ll.noticePeriod || profile.noticePeriod || '30 days'}
- Expected salary: ${ll.salary || profile.salary || '10 LPA'}
- Skills: ${ll.tools || 'Selenium, Playwright, TestNG, REST Assured, Postman, Jenkins, JIRA, SQL, Python'}
- Programming languages: ${ll.languages || 'Java, C#, Python, JavaScript, HTML/CSS, SQL'}
- Education: ${ll.education || 'Master of Computer Application (MCA)'}
- LinkedIn: ${ll.linkedIn || profile.linkedIn || ''}
- Portfolio: ${ll.portfolio || profile.portfolio || ''}
- GitHub: ${ll.github || profile.github || ''}
- Willing to relocate: ${ll.relocation || 'Yes, open to hybrid/remote'}

Extended Learning Context (Prior answered questions):
${fullContext}
`.trim();

  const optionsList = options.length
    ? `\nAvailable options (you MUST choose one of these exactly): ${options.join(' | ')}`
    : '';

  const prompt = `You are filling out a job application form on behalf of a candidate.
Use the provided profile and the extended learning context to decide the best answer.

${profileSummary}
${hint ? `Context: ${hint}` : ''}

The form asks: "${question}"
Field type: ${fieldType}${optionsList}

Rules:
- Reply with ONLY the answer value, nothing else
- If it's a yes/no question, reply: Yes or No
- If it's a number, reply with just the number
- Keep answers concise but professional
- If you cannot determine the answer from the profile, make a reasonable professional assumption
- For authorization/eligibility questions, answer Yes
- For "are you willing to..." questions, answer Yes${options.length ? '\n- Your answer MUST exactly match one of the available options' : ''}

Answer:`;

  try {
    const raw = await askAI(prompt, { temperature: 0.2, num_predict: 150 });
    const answer = (raw || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
    logger.info(`[AI] Field "${question.substring(0, 50)}" → "${answer.substring(0, 80)}"`);

    // ── Step 2: Self-learn fallback when AI returned empty ──
    if (!answer) {
      const learnedId = db.recordUnknownQuestion(question, fieldType, options, sourceJobId);
      // Immediately attempt self-learning with a broader creative prompt
      const guessed = await selfLearnAnswer(question, fieldType, options);
      if (guessed) {
        db.updateLearningAnswer(learnedId, guessed);
        logger.info(`[SelfLearn] Auto-answered "${question.substring(0, 50)}" → "${guessed}"`);
        console.log(`\nQuestion: ${question}\nResponse: ${guessed}\n  ↳ Self-learned answer generated and saved automatically.`);
        return guessed;
      }
      console.log(`\nQuestion: ${question}\nResponse: I was unable to answer this question.\n  ↳ Added to learning list for future self-learning.`);
    } else {
      console.log(`\nQuestion: ${question}\nResponse: ${answer}`);
    }

    // For option-constrained fields, verify the answer is in the options list
    if (options.length && answer) {
      const exact = options.find(o => o.toLowerCase() === answer.toLowerCase());
      const partial = options.find(o =>
        o.toLowerCase().includes(answer.toLowerCase()) ||
        answer.toLowerCase().includes(o.toLowerCase())
      );
      return (exact || partial || options[0] || answer);
    }

    return answer;
  } catch (err) {
    logger.warn(`[AI] answerField failed: ${err.message}`);
    // Self-learn even on AI error
    try {
      const learnedId = db.recordUnknownQuestion(question, fieldType, options, sourceJobId);
      const guessed = await selfLearnAnswer(question, fieldType, options);
      if (guessed) {
        db.updateLearningAnswer(learnedId, guessed);
        console.log(`\nQuestion: ${question}\nResponse: ${guessed}\n  ↳ Self-learned answer generated and saved automatically.`);
        return guessed;
      }
    } catch (_) {}
    console.log(`\nQuestion: ${question}\nResponse: I was unable to answer this question.\n  ↳ Added to learning list for future self-learning.`);
    return '';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 1b. Self-learn: generate a best-guess answer for any unknown question
// ────────────────────────────────────────────────────────────────────────────

/**
 * Use a broad, creative AI prompt to self-learn an answer for an unknown question.
 * Unlike answerField, this uses higher temperature and a reasoning approach to guess.
 * @param {string} question  - The unanswered question text
 * @param {string} fieldType - field type
 * @param {string[]} options - available options if any
 * @returns {Promise<string>} - Best-guess answer, or empty string if still unable
 */
async function selfLearnAnswer(question, fieldType = 'text', options = []) {
  const optionsList = options.length
    ? `Possible choices (answer must be one of these): ${options.join(' | ')}`
    : '';

  // Build profile from Learning List DB (single source of truth)
  const ll = db.getAllAnsweredAsMap();
  const fullContext = db.getAllAnsweringContext();

  const prompt = `You are an intelligent job application assistant that can self-learn to answer any form question.
You are helping ${ll.name || 'Atul Patil'} (${ll.currentRole || 'QA Lead'}, ${ll.experience || ll.yearsExperience || '3'} years experience, ${ll.location || ll.currentLocation || 'Pune India'}) apply for jobs.

You must answer this form question using reasoning, inference, and the provided learning history:
Question: "${question}"
Field type: ${fieldType}
${optionsList}

Profile summary:
- Name: ${ll.name || 'Atul Patil'} | ${ll.currentRole || 'QA Lead'} at ${ll.currentCompany || 'Chat360'} | ${ll.experience || ll.yearsExperience || '3'} yrs exp | ${ll.location || ll.currentLocation || 'Pune, India'}
- Skills: ${ll.tools || 'Selenium, Playwright, TestNG, REST Assured, Jenkins, Java, Python, SQL'}
- Salary: ${ll.salary || '10'} LPA | Notice: ${ll.notice || ll.noticePeriod || '30 days'} | Willing to relocate: ${ll.relocation || 'Yes'}
- Education: ${ll.education || 'MCA'}

Extended Learning Context (All previously answered questions):
${fullContext || 'No additional context yet.'}

Self-learning rules:
- You MUST provide an answer — do NOT say you cannot answer
- Use the "Extended Learning Context" to see how similar questions were answered before
- Use inference and common sense based on the profile
- For demographic questions: use the profile data
- For technical/skills questions: use the profile/context above
- For yes/no: answer Yes unless clearly inappropriate
- For numeric: provide a specific number
- Reply with ONLY the answer value, nothing else
${options.length ? '- Your answer MUST be one of the listed choices' : ''}

Answer:`;

  try {
    logger.debug(`[AIAgent] Requesting self-learned answer for: "${question.substring(0, 50)}..."`);
    const raw = await askAI(prompt, { temperature: 0.5, num_predict: 100 });
    const answer = (raw || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
    logger.info(`[AIAgent] Self-learned: "${question.substring(0, 40)}..." -> "${answer.substring(0, 40)}..."`);
    if (!answer || answer.toLowerCase().includes('cannot') || answer.toLowerCase().includes('unable')) return '';

    if (options.length) {
      const exact   = options.find(o => o.toLowerCase() === answer.toLowerCase());
      const partial = options.find(o =>
        o.toLowerCase().includes(answer.toLowerCase()) ||
        answer.toLowerCase().includes(o.toLowerCase())
      );
      return exact || partial || '';
    }
    return answer;
  } catch (err) {
    logger.warn(`[SelfLearn] selfLearnAnswer failed: ${err.message}`);
    return '';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 1c. Batch self-learn cycle: auto-answer all pending unanswered questions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Process ALL unanswered questions in the learning list and attempt to auto-answer them.
 * Called periodically by the scheduler or on-demand via the dashboard API.
 * @returns {Promise<{processed:number, answered:number}>}
 */
async function runSelfLearnCycle() {
  const pending = db.getLearningQuestions(500).filter(r => !r.answered);
  logger.info(`[SelfLearn] Starting cycle: ${pending.length} unanswered questions`);

  let answeredCount = 0;
  for (const row of pending) {
    try {
      let opts = [];
      try { opts = JSON.parse(row.options || '[]'); } catch (_) {}
      const answer = await selfLearnAnswer(row.question, row.field_type, opts);
      if (answer) {
        db.updateLearningAnswer(row.id, answer);
        answeredCount++;
        logger.info(`[SelfLearn] Auto-answered id=${row.id} "${row.question.substring(0, 50)}" → "${answer}"`);
      }
    } catch (err) {
      logger.warn(`[SelfLearn] Failed for id=${row.id}: ${err.message}`);
    }
  }

  logger.info(`[SelfLearn] Cycle complete: ${answeredCount}/${pending.length} auto-answered`);
  return { processed: pending.length, answered: answeredCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Decide the next click action on a page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask AI what to click next to advance a job application.
 * @param {string} pageText - Visible text content of the current page
 * @param {string} goal     - What we're trying to accomplish
 * @returns {Promise<{action:string, target:string, reason:string}>}
 */
async function decideNextAction(pageText, goal = 'complete job application') {
  const truncated = pageText.substring(0, 3000);

  const prompt = `You are a browser automation agent navigating a job application page.

Goal: ${goal}

Page content (visible text):
---
${truncated}
---

Decide the SINGLE best next action. Reply with ONLY a valid JSON object, no extra text:
{"action":"click","target":"exact button or link text to click","reason":"short reason"}

Rules:
- action must be: "click", "skip" (if already submitted/done), or "wait"
- target must be exact visible text of a button, link, or interactive element on the page
- Prefer: Submit, Apply, Next, Continue, Save & Continue, Proceed, Send Application
- If the page shows a success/thank-you message, use: {"action":"skip","target":"","reason":"already submitted"}
- If a CAPTCHA is visible, use: {"action":"wait","target":"captcha","reason":"manual intervention needed"}`;

  try {
    const raw = await askAI(prompt, { temperature: 0.1, num_predict: 120 });
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

/**
 * Ask AI whether the current page confirms a successful application.
 * @param {string} pageText - Visible text of the current page
 * @returns {Promise<boolean>}
 */
async function isApplicationComplete(pageText) {
  const truncated = pageText.substring(0, 2000);

  const prompt = `Does the following page content indicate that a job application was SUCCESSFULLY submitted?

Page content:
---
${truncated}
---

Reply with ONLY one word: YES or NO`;

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
// 4. Analyze full page to extract all Q&A pairs at once
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask AI to analyze the entire form page and return answers for all fields.
 * This is more efficient than calling answerField() per field — one AI call covers all.
 * @param {string} formText  - Full visible text of the form with field labels
 * @param {object} profile   - Candidate profile
 * @returns {Promise<Array<{label:string, answer:string}>>}
 */
async function analyzeFormAndAnswer(formText, profile = {}) {
  // Build profile from Learning List DB (single source of truth)
  const ll = db.getAllAnsweredAsMap();
  const fullContext = db.getAllAnsweringContext();

  const profileSummary = `
Name: ${ll.name || profile.name || 'Atul Patil'}
Email: ${ll.email || profile.email || ''}
Phone: ${ll.phone || profile.phone || ''}
Location: ${ll.location || ll.currentLocation || profile.location || 'Pune, India'}
Role: ${ll.currentRole || profile.currentRole || 'QA Lead'} at ${ll.currentCompany || profile.currentCompany || 'Chat360'}
Experience: ${ll.experience || ll.yearsExperience || profile.yearsOfExperience || '3'} years
Notice: ${ll.notice || ll.noticePeriod || profile.noticePeriod || '30 days'}
Salary expectation: ${ll.salary || profile.salary || '10'} LPA
Skills: ${ll.tools || 'Selenium, Playwright, Java, Python, Jenkins'}

Extended Learning History:
${fullContext || 'No existing history.'}
`.trim();

  const prompt = `Analyze this job application form and provide answers for all clear questions/fields.
Use the Candidate Profile and the Extended Learning History to decide the best answers.

${profileSummary}

[
  {"label": "field label or question", "answer": "value to enter"},
  ...
]

Rules:
- Include only fields that clearly need text input (not buttons)
- For yes/no fields: use "Yes" or "No"
- For number fields: use just the number (e.g. "3" for years of experience)
- For salary: use "10 LPA" or "1000000"
- Skip fields that don't apply to this candidate
- max 20 entries`;

  try {
    const raw = await askAI(prompt, { temperature: 0.2, num_predict: 800 });
    const jsonMatch = (raw || '').match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const results = JSON.parse(jsonMatch[0]);
      logger.info(`[AI] Form analysis: ${results.length} field answers generated`);
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
};

