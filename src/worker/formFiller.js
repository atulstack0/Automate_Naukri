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
  { keys: ['years of experience', 'total experience', 'work experience', 'experience in years', 'years experince', 'years experience', 'how many years', 'mcu testing'], answerKey: 'experience' },
  { keys: ['current role', 'current designation', 'present role'],           answerKey: 'currentRole' },
  { keys: ['current company', 'present company', 'employer'],                answerKey: 'currentCompany' },
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
  if (answerKey === 'experience') {
    return qaAnswers.experience || profile.experience || profile.yearsExperience || '';
  }
  return qaAnswers[answerKey] || profile[answerKey] || '';
}

/**
 * Extract a human-readable label for a form element by walking the DOM.
 */
async function getElementLabel(page, elementHandle) {
  try {
    return await page.evaluate((el) => {
      // Helper to clean duplicated text (e.g. "LabelLabel")
      function cleanDuplicatedText(str) {
        if (!str) return '';
        const s = str.trim();
        const half = Math.floor(s.length / 2);
        if (s.length > 0 && s.substring(0, half) === s.substring(s.length - half)) {
          return s.substring(0, half).trim();
        }
        return s;
      }

      // Helper to find bot message context for chatbots
      function findChatbotContext(input) {
        // Deep search: look for the last text element in the entire document (or scoped drawer)
        // that looks like a question and is above the input.
        const allElements = Array.from(document.querySelectorAll('*'));
        const inputIndex = allElements.indexOf(input);

        // Search backwards from the input up to 100 elements just to be safe
        let searchLimit = Math.max(0, inputIndex - 100);
        for (let i = inputIndex - 1; i >= searchLimit; i--) {
          const node = allElements[i];
          // Skip if it's a hidden element or a script/style
          if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'SVG' || node.tagName === 'PATH') continue;
          
          let text = (node.innerText || node.textContent || '').trim();
          
          // Filter out generic short texts
          if (text.length > 5 && (text.includes('?') || text.toLowerCase().includes('how many') || text.toLowerCase().includes('experience'))) {
            // Because innerText cascades up, we want the most specific node (least children)
            // that contains the text
            if (node.children.length === 0 || (node.children.length === 1 && node.children[0].tagName === 'SPAN')) {
                return text;
            }
          }
        }
        return null;
      }

      const rawLabel = (function() {
        // Try: aria-label
        if (el.ariaLabel) return el.ariaLabel;
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        // Try: placeholder
        if (el.placeholder) return el.placeholder;
        if (el.getAttribute('data-placeholder')) return el.getAttribute('data-placeholder');
        // Try: associated <label>
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) return lbl.innerText || lbl.textContent;
        }
        // Try: wrapping label
        const parent = el.closest('label');
        if (parent) return parent.innerText || parent.textContent;
        
        // Try: preceding sibling or parent text
        // Specific for LinkedIn: look for a sibling with class .artdeco-text-input--label or .fb-form-element-label
        const container = el.closest('.fb-form-element, .artdeco-text-input, .artdeco-dropdown');
        if (container) {
          const lblNode = container.querySelector('.fb-form-element-label, .artdeco-text-input--label, label');
          if (lblNode) return lblNode.innerText || lblNode.textContent;
        }

        const p = el.parentElement;
        if (p) return p.innerText || p.textContent || '';
        return '';
      })();

      let clean = (rawLabel || '').trim();
      clean = cleanDuplicatedText(clean);
      
      const isContentEditable = el.getAttribute('contenteditable') === 'true' || el.classList.contains('textArea') || el.classList.contains('chatbot_InputContainer');
      // If label is generic like "Type message here..." OR if it's an explicit chatbot interactive div, find the actual question text
      if (isContentEditable || !clean || /type message|enter answer|reply|your message|type here|chat/i.test(clean)) {
        const context = findChatbotContext(el);
        if (context) return cleanDuplicatedText(context);
      }

      return clean;
    }, elementHandle);
  } catch (_) {
    return '';
  }
}

/**
 * Get the current value of a form element.
 */
async function getElementValue(page, elementHandle) {
  try {
    return await page.evaluate(el => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') {
        const idx = el.selectedIndex;
        if (idx === -1) return '';
        return el.options[idx].text || el.options[idx].value || '';
      }
      if (el.type === 'checkbox' || el.type === 'radio') {
        return el.checked ? 'Checked' : 'Unchecked';
      }
      return el.value || el.innerText || '';
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
  const { qaAnswers = {}, profile = {}, resumePath, skipAI = false, scopeSelector = '' } = config;
  const unmatched = [];

  logger.info(`[FormFiller] Starting AI-augmented fill: ${skipAI ? 'Keyword only' : 'Hybrid AI'} (Scope: ${scopeSelector || 'None'})`);

  // Define the root locator (whole page or a specific modal/drawer)
  let root = scopeSelector ? page.locator(scopeSelector).first() : page;
  let activeScope = scopeSelector;
  
  // Check if scope exists
  if (scopeSelector) {
    const exists = await root.count();
    if (exists === 0) {
      logger.warn(`[FormFiller] Scope selector "${scopeSelector}" not found – falling back to page`);
      root = page;
      activeScope = '';
    } else {
      logger.debug(`[FormFiller] Scoped to: "${scopeSelector}"`);
    }
  }

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
        const pageText = await root.evaluate((el) => el.innerText || document.body.innerText).catch(() => '');
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
    for (const [mapKey, val] of Object.entries(aiAnswerMap)) {
      if (key.includes(mapKey) || mapKey.includes(key)) return val;
    }
    return null;
  }

  // Helper: fuzzy match label text against learning_questions table (Pass 2.5)
  // Works even when skipAI=true — uses the user's saved Q&A answers.
  let _learningCache = null;
  function lookupLearning(labelText) {
    try {
      if (!_learningCache) {
        // Load all answered questions once per fillFormSmart call
        _learningCache = db.getLearningQuestions(500).filter(r => r.answered && r.answer && r.question);
      }
      const fieldWords = (labelText || '').toLowerCase().split(/\W+/).filter(w => w.length > 2);
      if (!fieldWords.length) return null;

      let bestAnswer = null, bestScore = 0;
      for (const row of _learningCache) {
        const qWords = row.question.toLowerCase().split(/\W+/).filter(w => w.length > 2);
        if (!qWords.length) continue;
        const matched = fieldWords.filter(w => qWords.includes(w)).length;
        const score   = matched / Math.max(fieldWords.length, qWords.length);
        if (score > bestScore) { bestScore = score; bestAnswer = row.answer; }
      }
      if (bestScore >= 0.35 && bestAnswer) {
        logger.debug(`[FormFiller] Learning list match (${Math.round(bestScore*100)}%) "${labelText?.substring(0,40)}" → "${bestAnswer?.substring(0,40)}"`);
        return bestAnswer;
      }
    } catch (e) {
      logger.debug('[FormFiller] lookupLearning error: ' + e.message);
    }
    return null;
  }

  // ── Text inputs & textareas ────────────────────────────────────────────
  const inputSelectors = [
    'input[type="text"]', 'input:not([type])', 'input[type="email"]', 'input[type="tel"]',
    'input[type="number"]', 'input[type="url"]', 'textarea',
    '[contenteditable="true"]', '.textArea', '.chatbot_InputContainer textarea', '.chatbot_InputContainer input', '.bottom-chat input'
  ];

  let totalInputsFound = 0;
  for (const sel of inputSelectors) {
    // If scoped, search within root, otherwise search page
    const elements = activeScope ? await root.locator(sel).all() : await page.locator(sel).all();
    totalInputsFound += elements.length;
    for (const el of elements) {
      try {
        const isVisible = await el.isVisible();
        const isEnabled = await el.isEnabled();
        if (!isVisible || !isEnabled) continue;

        const handle = await el.elementHandle();
        const label  = await getElementLabel(page, handle);
        if (!label) {
          const outerHTML = await el.evaluate(e => e.outerHTML).catch(()=>'error');
          logger.warn(`[FormFiller] Skipping field [${sel}] - no label extracted. HTML: ${outerHTML}`);
          
          // ALWAYS process chatbot input containers or editable divs even if aria-labels are missing
          const isEditableDiv = outerHTML.includes('contenteditable="true"');
          const isChatbotClass = outerHTML.toLowerCase().includes('textarea') || outerHTML.toLowerCase().includes('chatbot');
          
          if (!isEditableDiv && !isChatbotClass) {
              continue;
          }
        }

        logger.debug(`[FormFiller] Processing field: "${(label||'bot input').trim().substring(0, 40)}" [${sel}]`);

        // Detect validation errors
        const errorText = await el.evaluate(input => {
          const parent = input.closest('.fb-form-element, .artdeco-text-input, .artdeco-dropdown, div');
          if (!parent) return null;
          // LinkedIn uses .artdeco-inline-feedback__message or variants. Catch all error feedbacks.
          const errorMsg = parent.querySelector('.artdeco-inline-feedback--error, .artdeco-inline-feedback__message, [id*="error"], .validation-error, [role="alert"]');
          return errorMsg ? errorMsg.innerText.trim() : null;
        });

        if (errorText) {
          logger.warn(`[FormFiller] Validation error detected for "${label}": ${errorText}`);
        }

        // Pass 1: keyword match (skip if error, as we need fresh AI logic)
        let answer = '';
        if (!errorText) {
          const match = label ? findBestMatch(label) : null;
          if (match) {
            answer = getAnswer(match.answerKey, qaAnswers, profile);
            logger.info(`[FormFiller] Keyword "${label.trim().substring(0, 50)}" → ${match.answerKey}`);
          }
        }

        // Pass 2: AI batch map (skip if error)
        if (!answer && !errorText) {
          answer = lookupAiMap(label) || '';
          if (answer) logger.info(`[FormFiller] AI-map "${label.trim().substring(0, 50)}" → "${answer.substring(0, 60)}"`);
        }

        // Pass 2.5: Learning list label-text fuzzy match (works even when skipAI=true)
        if (!answer && !errorText && label) {
          answer = lookupLearning(label) || '';
          if (answer) logger.info(`[FormFiller] Learning-list "${label.trim().substring(0, 50)}" → "${answer.substring(0, 60)}"`);
        }

        // Pass 3: per-field AI call (always do if error or unknown)
        if (!answer && !skipAI) {
          const rejectedValue = errorText ? await getElementValue(page, handle) : '';
          
          // Auto-detect numeric fields from label context
          let typeOverride = 'text';
          if (/how many years|how much|total years|experience with/i.test(label || '')) {
             typeOverride = 'number';
          }

          answer = await answerField(label, typeOverride, [], profile, errorText || '', null, rejectedValue);
          if (answer) logger.info(`[FormFiller] AI-field "${label.trim().substring(0, 50)}" → "${answer.substring(0, 60)}" ${errorText ? `(RETRY: rejected "${rejectedValue}")` : ''}`);
        }

        if (!answer) {
          const isBot = sel.includes('contenteditable') || sel.includes('chatbot') || sel.includes('textArea');
          if (isBot) {
            logger.warn(`[FormFiller] Chatbot question "${label}" unmatched. Defaulting to "Yes" to bypass.`);
            answer = "Yes";
          } else {
            const clean = (label || '').trim().replace(/\s+/g, ' ').substring(0, 100);
            if (clean.length > 2) unmatched.push({ label: clean, type: 'text' });
            continue;
          }
        }

        await el.click();
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Delete');
        await randomDelay(80, 200);

        // For inputs/textareas, .fill or .type works best. For contenteditable divs, page.keyboard works best.
        try {
          // Playwright 1.39+ natively prefers .fill() over .type(), but type() simulates keystrokes better 
          // However, div elements sometimes reject both. Try fill, fallback to raw keyboard.
          const tag = await el.evaluate(e => e.tagName);
          if (tag === 'DIV') {
            await page.keyboard.type(String(answer), { delay: Math.floor(Math.random() * 50) + 25 });
          } else {
             // Fallback to type for backwards compatibility with input fields
             await el.type(String(answer), { delay: Math.floor(Math.random() * 50) + 25 });
          }
        } catch(fillErr) {
          logger.debug(`[FormFiller] .type() failed, using raw keyboard...`);
          await el.click();
          await page.keyboard.type(String(answer), { delay: Math.floor(Math.random() * 50) + 25 });
        }
        
        await randomDelay(150, 400);

        // Chatbot support: press ENTER if it's a message-style input or a known chatbot selector
        const isBotInput = sel.includes('contenteditable') || sel.includes('chatbot') || sel.includes('textArea') || /type message|enter answer|reply|your message|type here|chat/i.test(label);
        if (isBotInput) {
          logger.info(`[FormFiller] Identified chatbot input, pressing ENTER`);
          await page.keyboard.press('Enter');
          await randomDelay(1500, 3000); // Wait for bot response
          unmatched.chatbotInteracted = true;
        }
      } catch (err) {
        logger.debug(`[FormFiller] Input error: ${err.message}`);
      }
    }
  }

  // ── Select / Dropdowns ────────────────────────────────────────────────
  const selects = activeScope ? await root.locator('select').all() : await page.locator('select').all();
  for (const sel of selects) {
    try {
      const isVisible = await sel.isVisible();
      if (!isVisible) continue;

      const handle  = await sel.elementHandle();
      const label   = await getElementLabel(page, handle);
      if (label) {
        logger.debug(`[FormFiller] Processing select: "${label.trim().substring(0, 40)}"`);
      }
      const options = await page.evaluate(el =>
        Array.from(el.options).map(o => ({ value: o.value, text: o.text })), handle
      );
      const optTexts = options.map(o => o.text).filter(t => t && t.toLowerCase() !== 'select');

      // Detect validation errors
      const errorText = await sel.evaluate(el => {
        const parent = el.closest('.fb-form-element, .artdeco-dropdown, div');
        if (!parent) return null;
        const errorMsg = parent.querySelector('.artdeco-inline-feedback--error, .artdeco-inline-feedback__message, [id*="error"], .validation-error, [role="alert"]');
        return errorMsg ? errorMsg.innerText.trim() : null;
      });

      if (errorText) {
        logger.warn(`[FormFiller] Validation error detected for select "${label}": ${errorText}`);
      }

      // Pass 1: keyword match (skip if error)
      let answer = '';
      if (!errorText) {
        const match = findBestMatch(label);
        if (match) answer = getAnswer(match.answerKey, qaAnswers, profile);
      }

      // Pass 2: AI batch map (skip if error)
      if (!answer && !errorText) answer = lookupAiMap(label) || '';

      // Pass 2.5: Learning list fuzzy match
      if (!answer && !errorText && label) answer = lookupLearning(label) || '';
      if (answer && !errorText) logger.info(`[FormFiller] Learning-list select "${label?.trim().substring(0,40)}" → "${answer}"`);

      // Pass 3: per-field AI call with options
      if (!answer && !skipAI && optTexts.length) {
        const rejectedValue = errorText ? await getElementValue(page, handle) : '';
        answer = await answerField(label, 'select', optTexts, profile, errorText || '', null, rejectedValue);
        if (answer) logger.info(`[FormFiller] AI-select "${label.trim().substring(0, 50)}" → "${answer}" ${errorText ? `(RETRY: rejected "${rejectedValue}")` : ''}`);
      }

      if (answer) {
        const cleanAnswer = (answer || '').toLowerCase().replace(/[^\w\d+]/g, '');
        
        let best = options.find(o => o.text.toLowerCase() === answer.toLowerCase());
        
        if (!best) {
          best = options.find(o => {
            const t = o.text.toLowerCase();
            const a = answer.toLowerCase();
            // Standard inclusion
            if (t.includes(a) || a.includes(t)) return true;
            // Phone code special handling: match "+91" in "India (+91)"
            const tDigits = t.replace(/[^\d+]/g, '');
            const aDigits = a.replace(/[^\d+]/g, '');
            if (aDigits && tDigits && (tDigits === aDigits || tDigits.includes(aDigits))) return true;
            return false;
          });
        }
        
        // Final fallback: only if no match at all AND it's not a dummy option
        if (!best) {
          best = options.find(o => o.value !== '' && !/select|choose|none/i.test(o.text));
        }

        if (best) {
          const chosenVal = best.value;
          logger.info(`[FormFiller] Select [${label.substring(0, 20)}]: Choosing value "${chosenVal}"`);
          await sel.selectOption({ value: chosenVal }).catch(() => {});
          logger.info(`[FormFiller] Select "${(label||'').trim().substring(0, 40)}" → "${best.text}"`);
          await randomDelay(150, 350);
        } else {
          const optValues = options.map(o => o.value);
          logger.warn(`[FormFiller] Select [${label.substring(0, 20)}]: No matching option found for "${answer}" among [${optValues.join(', ')}]`);
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
    const radioGroups = await root.evaluate((rootEl) => {
      const parent = rootEl === window ? document : rootEl;
      const radios = Array.from(parent.querySelectorAll('input[type="radio"]'));
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

      logger.debug(`[FormFiller] Processing radio group: "${groupLabel}" (${optLabels.length} options)`);

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
          const targetRadio = page.locator(`input[type="radio"][id="${best.id}"], input[type="radio"][value="${best.value}"][name="${groupName}"]`).first();
          if (await targetRadio.count() > 0 && await targetRadio.isVisible()) {
            logger.info(`[FormFiller] Radio [${groupLabel.substring(0, 20)}]: Clicking "${best.label}"`);
            await targetRadio.click().catch(() => {});
            logger.info(`[FormFiller] Radio "${groupLabel}" → "${best.label}"`);
            await randomDelay(100, 250);
          } else {
            logger.warn(`[FormFiller] Radio [${groupLabel.substring(0, 20)}]: Option "${best.label}" not found or not visible among [${optLabels.join(', ')}]`);
          }
        } else {
          logger.warn(`[FormFiller] Radio [${groupLabel.substring(0, 20)}]: No matching option found for "${chosen}" among [${optLabels.join(', ')}]`);
        }
      }
    }
  } catch (err) {
    logger.debug(`[FormFiller] Radio error: ${err.message}`);
  }

  // ── Checkboxes: consent/terms auto-check ─────────────────────────────
  const checkboxes = activeScope ? await root.locator('input[type="checkbox"]').all() : await page.locator('input[type="checkbox"]').all();
  for (const cb of checkboxes) {
    try {
      if (!await cb.isVisible()) continue;
      const handle = await cb.elementHandle();
      const label  = await getElementLabel(page, handle);
      if (label) {
        logger.debug(`[FormFiller] Checking checkbox: "${label.trim().substring(0, 40)}"`);
      }
      // Add high-density logs for checkboxes
      let val = null; // Initialize val
      const match = findBestMatch(label);
      if (match) {
        val = getAnswer(match.answerKey, qaAnswers, profile);
      }
      if (val === undefined || val === null) {
        logger.debug(`[FormFiller] No cached answer found for "${label.substring(0, 30)}", skipping...`);
        // continue; // Do not continue, let the auto-check logic run
      } else {
        logger.info(`[FormFiller] Match found: "${label.substring(0, 30)}" -> Key: "${match.answerKey}" -> Value: "${typeof val === 'string' ? val.substring(0, 30) : val}"`);
      }

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
  
  // Prevent blindly attaching a resume to every single chatbot question
  if (resumeAbs && fs.existsSync(resumeAbs) && !unmatched.chatbotInteracted && !config.blockResumeUpload) {
    const fileInputs = activeScope ? await root.locator('input[type="file"]').all() : await page.locator('input[type="file"]').all();
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
  } else if (resumePath && !config.blockResumeUpload && !unmatched.chatbotInteracted) {
    logger.warn(`[FormFiller] Resume not found at: ${resumePath}`);
  }

  if (unmatched.length) logger.warn('[FormFiller] Truly unmatched (AI + keyword both failed):', { unmatched });
  logger.info(`[FormFiller] Done. Unmatched: ${unmatched.length}`);
  return unmatched;
}

module.exports = { fillFormSmart };

