'use strict';

/**
 * formFiller.js
 * Hybrid form filler:
 *  Pass 1 – Fast: keyword scoring matches obvious fields (name, email, phone, etc.)
 *  Pass 2 – AI: any unmatched field is sent to Ollama to generate the best answer
 *  Pass 3 – AI batch: upfront analyzeFormAndAnswer() pre-builds an answer map for the whole form
 */

const path = require('path');
const fs   = require('fs');
const logger = require('../utils/logger');
const db     = require('../db/db');
const { randomDelay } = require('../utils/antiDetection');
const { answerField, analyzeFormAndAnswer } = require('../ai/aiAgent');

// Cache AI batch answers per page URL – avoids re-calling Gemini on the same page
// across multiple fillFormSmart calls (e.g. repeated step-checks)
const _aiAnswerCache = new Map();
const _AI_CACHE_MAX = 20;  // max pages to keep in memory

// -----------------------------------------------------------------------
// Keyword → answer-key map.
// Each entry: { keys: [...keywords], answerKey: 'qaAnswers.xxx' }
// -----------------------------------------------------------------------
const FIELD_MAP = [
  // Identity
  { keys: ['full name', 'your name', 'first name', 'applicant name'],        answerKey: 'name' },
  { keys: ['last name', 'surname'],                                            answerKey: 'name' },
  { keys: ['email', 'e-mail', 'mail id'],                                      answerKey: 'email' },
  { keys: ['phone', 'mobile', 'contact number', 'cell'],                      answerKey: 'phone' },
  { keys: ['linkedin', 'linked in', 'linkedin url'],                          answerKey: 'linkedIn' },
  { keys: ['portfolio', 'personal website', 'website url'],                   answerKey: 'portfolio' },
  { keys: ['github', 'git hub'],                                               answerKey: 'github' },

  // Location & availability
  { keys: ['current location', 'city', 'location', 'where are you based'],   answerKey: 'location' },
  { keys: ['notice period', 'when can you join', 'joining', 'availability'], answerKey: 'notice' },
  { keys: ['relocation', 'remote', 'work from home', 'wfh', 'hybrid'],       answerKey: 'relocation' },

  // Experience
  { keys: ['years of experience', 'total experience', 'work experience', 'experience in years'], answerKey: 'experience' },
  { keys: ['current role', 'current designation', 'present role'],           answerKey: 'currentRole' },
  { keys: ['current company', 'present company', 'employer'],                answerKey: 'currentRole' },
  { keys: ['previous role', 'past role', 'work history', 'career history'], answerKey: 'previousRoles' },
  { keys: ['responsibilities', 'key responsibilities', 'job role', 'what do you do'], answerKey: 'responsibilities' },

  // Technical
  { keys: ['programming language', 'languages known', 'coding language'],    answerKey: 'languages' },
  { keys: ['tools', 'testing tools', 'automation tool', 'tech stack', 'skills'], answerKey: 'tools' },
  { keys: ['selenium', 'playwright'],                                          answerKey: 'selenium' },
  { keys: ['testng', 'junit', 'parallel test'],                               answerKey: 'testng' },
  { keys: ['rest assured', 'restassured', 'rest-assured'],                    answerKey: 'restAssured' },
  { keys: ['api testing', 'api test', 'rest api', 'web service'],             answerKey: 'apiTesting' },
  { keys: ['ci/cd', 'cicd', 'jenkins', 'pipeline', 'continuous integration'], answerKey: 'cicd' },
  { keys: ['framework', 'test framework', 'automation framework'],            answerKey: 'frameworks' },
  { keys: ['sql', 'database', 'db testing'],                                  answerKey: 'sql' },
  { keys: ['genai', 'gen ai', 'ai testing', 'llm', 'machine learning'],       answerKey: 'genai' },
  { keys: ['improvement', 'impact', 'achievement in testing', 'efficiency'],  answerKey: 'improvements' },

  // Education
  { keys: ['highest qualification', 'education', 'degree', 'qualification'],  answerKey: 'education' },
  { keys: ['undergraduate', 'bachelor', 'bsc', 'b.sc', 'ug degree'],          answerKey: 'undergraduate' },

  // HR/Behavioral
  { keys: ['why this role', 'why are you interested', 'motivation', 'why apply'], answerKey: 'whyRole' },
  { keys: ['strength', 'strong point', 'what are you good at'],                answerKey: 'strengths' },
  { keys: ['weakness', 'area of improvement', 'where can you improve'],        answerKey: 'weaknesses' },
  { keys: ['award', 'achievement', 'recognition', 'accomplishment'],           answerKey: 'awards' },

  // Salary
  { keys: ['salary', 'ctc', 'compensation', 'expected salary', 'package', 'lpa'], answerKey: 'salary' },

  // Cover letter / summary
  { keys: ['cover letter', 'coverletter', 'why should we hire'],               answerKey: 'coverLetter' },
  { keys: ['professional summary', 'profile summary', 'brief about yourself', 'about yourself', 'introduce yourself', 'tell us about'], answerKey: 'shortSummary' },
];

/**
 * Score a label string against a set of keywords (0–100).
 */
function scoreLabel(label, keywords) {
  const lower = (label || '').toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      score += (kw.length / lower.length) * 100;
    }
  }
  return Math.min(score, 100);
}

/**
 * Find the best Q&A answer for a given label string.
 * Returns { answerKey, score } or null if no match above threshold.
 */
function findBestMatch(labelText, threshold = 20) {
  let best = null;
  for (const entry of FIELD_MAP) {
    const s = scoreLabel(labelText, entry.keys);
    if (s > threshold && (!best || s > best.score)) {
      best = { answerKey: entry.answerKey, score: s };
    }
  }
  return best;
}

/**
 * Get the answer value — Learning List DB is the primary source.
 * Falls back to qaAnswers / profile only if DB has no answer.
 */
function getAnswer(answerKey, qaAnswers, profile) {
  // Primary source: Learning List DB
  const dbAnswer = db.findAnswerByKey(answerKey);
  if (dbAnswer) {
    // Special compound: salary → "X LPA"
    if (answerKey === 'salary' && /^\d+$/.test(dbAnswer.trim())) return `${dbAnswer} LPA`;
    return dbAnswer;
  }

  // Fallback: config.json data (backward compat)
  if (answerKey === 'salary') {
    const raw = qaAnswers.salary || profile.salary || '';
    if (/^\d+$/.test(raw.trim())) return `${raw} LPA`;
    return 'Open to market standards for this role; exact expectation can be discussed after understanding role responsibilities.';
  }
  if (answerKey === 'linkedIn' && !qaAnswers.linkedIn) {
    return profile.linkedIn || '';
  }
  return qaAnswers[answerKey] || profile[answerKey] || '';
}

/**
 * Extract a human-readable label for a form element by walking the DOM.
 */
async function getElementLabel(page, elementHandle) {
  try {
    return await page.evaluate((el) => {
      // Try: aria-label
      if (el.ariaLabel) return el.ariaLabel;
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      // Try: placeholder
      if (el.placeholder) return el.placeholder;
      // Try: associated <label>
      if (el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        if (lbl) return lbl.textContent;
      }
      // Try: wrapping label
      const parent = el.closest('label');
      if (parent) return parent.textContent;
      // Try: preceding sibling or parent text
      const p = el.parentElement;
      if (p) return p.innerText || p.textContent || '';
      return '';
    }, elementHandle);
  } catch (_) {
    return '';
  }
}

/**
 * Main entry: fill all visible form fields on the current page.
 * Uses keyword matching FIRST (fast), then AI for any unmatched fields.
 * Returns a list of truly unmatched questions (AI also couldn't answer).
 */
async function fillFormSmart(page, config) {
  const { qaAnswers = {}, profile = {}, resumePath, skipAI = false } = config;
  const unmatched = [];

  logger.info('[FormFiller] Starting AI-augmented smart form fill...');

  // ── AI Pass 0: batch-analyze the whole form for an answer map ──────────
  // Cached by page URL – one Gemini call per page, not per fillFormSmart() invocation
  let aiAnswerMap = {};
  if (!skipAI) {
    const cacheKey = page.url();
    if (_aiAnswerCache.has(cacheKey)) {
      aiAnswerMap = _aiAnswerCache.get(cacheKey);
      logger.info(`[FormFiller] AI answer map from cache (${Object.keys(aiAnswerMap).length} entries)`);
    } else {
      try {
        const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
        const aiAnswers = await analyzeFormAndAnswer(pageText, profile);
        for (const { label, answer } of aiAnswers) {
          if (label && answer) aiAnswerMap[label.toLowerCase().trim()] = answer;
        }
        // Store in cache
        _aiAnswerCache.set(cacheKey, aiAnswerMap);
        if (_aiAnswerCache.size > _AI_CACHE_MAX) {
          // Evict oldest entry
          _aiAnswerCache.delete(_aiAnswerCache.keys().next().value);
        }
        logger.info(`[FormFiller] AI pre-built ${Object.keys(aiAnswerMap).length} answers (cached)`);
      } catch (err) {
        logger.warn('[FormFiller] AI batch analysis failed, continuing with keyword match', { err: err.message });
      }
    }
  }

  // Helper: look up AI answer map by label (fuzzy)
  function lookupAiMap(label) {
    const key = label.toLowerCase().trim();
    if (aiAnswerMap[key]) return aiAnswerMap[key];
    // Partial match
    for (const [mapKey, val] of Object.entries(aiAnswerMap)) {
      if (key.includes(mapKey) || mapKey.includes(key)) return val;
    }
    return null;
  }

  // ── Text inputs & textareas ────────────────────────────────────────────
  const inputSelectors = [
    'input[type="text"]', 'input[type="email"]', 'input[type="tel"]',
    'input[type="number"]', 'input[type="url"]', 'textarea',
  ];

  for (const sel of inputSelectors) {
    const elements = await page.locator(sel).all();
    for (const el of elements) {
      try {
        const isVisible = await el.isVisible();
        const isEnabled = await el.isEnabled();
        if (!isVisible || !isEnabled) continue;

        const handle = await el.elementHandle();
        const label  = await getElementLabel(page, handle);
        if (!label) continue;

        // Pass 1: keyword match
        let answer = '';
        const match = findBestMatch(label);
        if (match) {
          answer = getAnswer(match.answerKey, qaAnswers, profile);
          logger.info(`[FormFiller] Keyword "${label.trim().substring(0, 50)}" → ${match.answerKey}`);
        }

        // Pass 2: AI batch map
        if (!answer) {
          answer = lookupAiMap(label) || '';
          if (answer) logger.info(`[FormFiller] AI-map "${label.trim().substring(0, 50)}" → "${answer.substring(0, 60)}"`);
        }

        // Pass 3: per-field AI call for truly unknown fields
        if (!answer && !skipAI) {
          answer = await answerField(label, 'text', [], profile);
          if (answer) logger.info(`[FormFiller] AI-field "${label.trim().substring(0, 50)}" → "${answer.substring(0, 60)}"`);
        }

        if (!answer) {
          const clean = label.trim().replace(/\s+/g, ' ').substring(0, 100);
          if (clean.length > 2) unmatched.push({ label: clean, type: 'text' });
          continue;
        }

        await el.click();
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Delete');
        await randomDelay(80, 200);
        await el.type(String(answer), { delay: Math.floor(Math.random() * 50) + 25 });
        await randomDelay(150, 400);
      } catch (err) {
        logger.debug(`[FormFiller] Input error: ${err.message}`);
      }
    }
  }

  // ── Select / Dropdowns ────────────────────────────────────────────────
  const selects = await page.locator('select').all();
  for (const sel of selects) {
    try {
      const isVisible = await sel.isVisible();
      if (!isVisible) continue;

      const handle  = await sel.elementHandle();
      const label   = await getElementLabel(page, handle);
      const options = await page.evaluate(el =>
        Array.from(el.options).map(o => ({ value: o.value, text: o.text })), handle
      );
      const optTexts = options.map(o => o.text).filter(t => t && t.toLowerCase() !== 'select');

      // Pass 1: keyword match
      let answer = '';
      const match = findBestMatch(label);
      if (match) answer = getAnswer(match.answerKey, qaAnswers, profile);

      // Pass 2: AI batch map
      if (!answer) answer = lookupAiMap(label) || '';

      // Pass 3: per-field AI call with options
      if (!answer && !skipAI && optTexts.length) {
        answer = await answerField(label, 'select', optTexts, profile);
      }

      if (answer) {
        const best = options.find(o => o.text.toLowerCase() === answer.toLowerCase())
          || options.find(o => o.text.toLowerCase().includes(answer.toLowerCase())
            || answer.toLowerCase().includes(o.text.toLowerCase()))
          || options.find(o => o.value !== '' && o.text.toLowerCase() !== 'select');

        if (best) {
          await sel.selectOption({ value: best.value });
          logger.info(`[FormFiller] Select "${(label||'').trim().substring(0, 40)}" → "${best.text}"`);
          await randomDelay(150, 350);
        }
      } else {
        const clean = (label||'').trim().replace(/\s+/g, ' ').substring(0, 100);
        if (clean.length > 2) unmatched.push({ label: clean, type: 'select' });
      }
    } catch (err) {
      logger.debug(`[FormFiller] Select error: ${err.message}`);
    }
  }

  // ── Radio buttons ─────────────────────────────────────────────────────
  // Group radios by name, pick the right option via AI
  try {
    const radioGroups = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      const groups = {};
      for (const r of radios) {
        if (!r.name) continue;
        if (!groups[r.name]) groups[r.name] = [];
        const lbl = document.querySelector(`label[for="${r.id}"]`);
        groups[r.name].push({ id: r.id, value: r.value, label: lbl ? lbl.textContent.trim() : r.value });
      }
      return groups;
    });

    for (const [groupName, radioOptions] of Object.entries(radioGroups)) {
      const optLabels  = radioOptions.map(r => r.label);
      const groupLabel = groupName.replace(/[_-]/g, ' ');

      // Pass 1: keyword match
      let chosen = '';
      const match = findBestMatch(groupLabel);
      if (match) chosen = getAnswer(match.answerKey, qaAnswers, profile);

      // Pass 2: AI
      if (!chosen && !skipAI) {
        chosen = await answerField(groupLabel, 'radio', optLabels, profile);
      }

      if (chosen) {
        const best = radioOptions.find(r =>
          r.label.toLowerCase() === chosen.toLowerCase() ||
          r.label.toLowerCase().includes(chosen.toLowerCase()) ||
          chosen.toLowerCase().includes(r.label.toLowerCase())
        );
        if (best) {
          const radioEl = page.locator(`input[type="radio"][id="${best.id}"], input[type="radio"][value="${best.value}"][name="${groupName}"]`).first();
          if (await radioEl.count() > 0 && await radioEl.isVisible()) {
            await radioEl.click();
            logger.info(`[FormFiller] Radio "${groupLabel}" → "${best.label}"`);
            await randomDelay(100, 250);
          }
        }
      }
    }
  } catch (err) {
    logger.debug(`[FormFiller] Radio error: ${err.message}`);
  }

  // ── Checkboxes: consent/terms auto-check ─────────────────────────────
  const checkboxes = await page.locator('input[type="checkbox"]').all();
  for (const cb of checkboxes) {
    try {
      if (!await cb.isVisible()) continue;
      const handle = await cb.elementHandle();
      const label  = await getElementLabel(page, handle);
      const lower  = (label || '').toLowerCase();
      if (/agree|terms|consent|confirm|accept|privacy|authorize/i.test(lower)) {
        if (!await cb.isChecked()) {
          await cb.click();
          logger.info(`[FormFiller] Auto-checked: "${lower.substring(0, 50)}"`);
          await randomDelay(80, 200);
        }
      }
    } catch (err) {
      logger.debug(`[FormFiller] Checkbox error: ${err.message}`);
    }
  }

  // ── Resume Upload ─────────────────────────────────────────────────────
  const resumeAbs = resumePath ? path.resolve(process.cwd(), resumePath) : null;
  if (resumeAbs && fs.existsSync(resumeAbs)) {
    const fileInputs = await page.locator('input[type="file"]').all();
    for (const fi of fileInputs) {
      try {
        await fi.setInputFiles(resumeAbs);
        logger.info(`[FormFiller] Resume uploaded: ${path.basename(resumeAbs)}`);
        await randomDelay(1000, 2000);
        break;
      } catch (err) {
        logger.warn(`[FormFiller] Resume upload failed: ${err.message}`);
      }
    }
  } else if (resumePath) {
    logger.warn(`[FormFiller] Resume not found at: ${resumePath}`);
  }

  if (unmatched.length) logger.warn('[FormFiller] Truly unmatched (AI + keyword both failed):', { unmatched });
  logger.info(`[FormFiller] Done. Unmatched: ${unmatched.length}`);
  return unmatched;
}

module.exports = { fillFormSmart };

