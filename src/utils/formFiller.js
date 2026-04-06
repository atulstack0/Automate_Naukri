'use strict';

/**
 * src/utils/formFiller.js
 *
 * FormFiller — AI-assisted dynamic form filler for company career pages.
 * Used by companyWorker.js and legacy worker.js (fillFormSmart).
 */

const logger = require('./logger');
const { safeType, humanDelay } = require('./antiDetection');

class FormFiller {
  /**
   * @param {import('playwright').Page} page
   * @param {object} profile   - config.profile
   * @param {object} config    - full config
   */
  constructor(page, profile, config) {
    this.page    = page;
    this.profile = profile || {};
    this.config  = config  || {};
  }

  // ─────────────────────────────────────────────────────────────────────────
  // extractFormSnapshot
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Extracts all visible, fillable form fields from the current page.
   * Returns at most 30 fields.
   *
   * @returns {Promise<Array<{selector,type,label,placeholder,name,id,options}>>}
   */
  async extractFormSnapshot() {
    return this.page.evaluate(() => {
      /**
       * Build a unique CSS selector for a DOM element.
       * Priority: #id → [name] → nth-child fallback.
       */
      function buildSelector(el) {
        if (el.id) return `#${CSS.escape(el.id)}`;
        if (el.name) {
          const tag = el.tagName.toLowerCase();
          return `${tag}[name="${el.name}"]`;
        }
        // nth-child fallback
        const parent  = el.parentElement;
        const siblings = parent ? Array.from(parent.children) : [];
        const idx     = siblings.indexOf(el) + 1;
        const tag     = el.tagName.toLowerCase();
        return parent ? `${buildSelector(parent)} > ${tag}:nth-child(${idx})` : tag;
      }

      /** Find the closest visible label text for a field. */
      function findLabel(el) {
        // Explicit <label for="id">
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) return lbl.textContent.trim();
        }
        // aria-label / aria-labelledby
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        const lblId = el.getAttribute('aria-labelledby');
        if (lblId) {
          const lbl = document.getElementById(lblId);
          if (lbl) return lbl.textContent.trim();
        }
        // Ancestor <label>
        let parent = el.parentElement;
        while (parent && parent !== document.body) {
          if (parent.tagName === 'LABEL') return parent.textContent.trim().replace(/\s+/g, ' ');
          parent = parent.parentElement;
        }
        return '';
      }

      const SKIP_TYPES  = new Set(['hidden','submit','button','image','reset','file']);
      const SKIP_NAMES  = /csrf|token|nonce|_method|__/i;

      const results = [];

      // ── INPUT elements ──────────────────────────────────────────────────
      for (const el of document.querySelectorAll('input, select, textarea')) {
        if (results.length >= 30) break;

        const type = (el.type || el.tagName.toLowerCase()).toLowerCase();
        if (SKIP_TYPES.has(type)) continue;
        if (el.name && SKIP_NAMES.test(el.name)) continue;
        if (el.type === 'file') continue;

        // Skip invisible elements
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && el.tagName !== 'SELECT') continue;

        let options = [];
        if (el.tagName === 'SELECT') {
          options = Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim() }));
        }
        if (type === 'radio' || type === 'checkbox') {
          options = [{ value: el.value, text: el.value }];
        }

        results.push({
          selector:    buildSelector(el),
          type:        type === 'textarea' ? 'textarea' : type,
          label:       findLabel(el),
          placeholder: el.placeholder || '',
          name:        el.name  || '',
          id:          el.id    || '',
          options,
        });
      }

      return results;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // fillByMap
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fill form fields from an AI-generated field map { selector: value }.
   * @param {object} fieldMap
   */
  async fillByMap(fieldMap = {}) {
    const entries = Object.entries(fieldMap);
    logger.debug(`[FormFiller] fillByMap — ${entries.length} field(s)`);

    for (const [selector, value] of entries) {
      if (!value && value !== 0) continue;
      const strVal = String(value);

      try {
        // Determine field type from the snapshot or infer from selector
        const typeHint = await this.page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          if (el.tagName === 'SELECT')   return 'select';
          if (el.tagName === 'TEXTAREA') return 'textarea';
          return (el.type || 'text').toLowerCase();
        }, selector).catch(() => null);

        if (typeHint === null) continue; // element not found

        if (typeHint === 'select') {
          await this.page.selectOption(selector, strVal).catch(async () => {
            // Fallback: try selecting by label text
            await this.page.selectOption(selector, { label: strVal }).catch(() => {});
          });

        } else if (typeHint === 'radio' || typeHint === 'checkbox') {
          await this.page.check(selector).catch(() => {});

        } else if (typeHint === 'file') {
          // skip — handled separately by uploadResume()

        } else {
          // text / email / tel / number / textarea
          await safeType(this.page, selector, strVal);
        }

        await humanDelay(300, 700);

      } catch (err) {
        logger.debug(`[FormFiller] fillByMap error for "${selector}": ${err.message}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // uploadResume
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Find a file input and upload the resume.
   * @param {string} resumePath
   */
  async uploadResume(resumePath) {
    if (!resumePath) return;

    const FILE_SELECTORS = [
      'input[type="file"][accept*="pdf"]',
      'input[type="file"][name*="resume"]',
      'input[type="file"][name*="cv"]',
      'input[type="file"][id*="resume"]',
      'input[type="file"]',
    ];

    for (const sel of FILE_SELECTORS) {
      try {
        const el = await this.page.$(sel);
        if (el) {
          await el.setInputFiles(resumePath);
          logger.info(`[FormFiller] Resume uploaded via: ${sel}`);
          await humanDelay(2000, 3000);
          return;
        }
      } catch (err) {
        logger.debug(`[FormFiller] uploadResume "${sel}" failed: ${err.message}`);
      }
    }

    logger.debug('[FormFiller] No file input found for resume upload');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // submit
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Find and click the form submit button. Returns true if submission succeeded.
   */
  async submit() {
    const SUBMIT_SELECTORS = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Submit")',
      'button:has-text("Apply")',
      'button:has-text("Send")',
      'button:has-text("Send Application")',
      'button:has-text("Submit Application")',
      '[class*="submit"]:not([disabled])',
    ];

    const urlBefore = this.page.url();

    for (const sel of SUBMIT_SELECTORS) {
      try {
        const btn = this.page.locator(sel).first();
        if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn.click({ timeout: 8000 });
          logger.info(`[FormFiller] Clicked submit: "${sel}"`);

          await this.page.waitForTimeout(3000);

          // Success check 1: URL changed (navigated away from form)
          if (this.page.url() !== urlBefore) {
            logger.info('[FormFiller] URL changed after submit — assuming success');
            return true;
          }

          // Success check 2: success/thank-you text visible
          const successText = await this.page.evaluate(() => {
            const body = document.body.innerText.toLowerCase();
            return body.includes('thank you') || body.includes('application received')
              || body.includes('successfully') || body.includes('submitted');
          }).catch(() => false);

          if (successText) {
            logger.info('[FormFiller] Success text found after submit');
            return true;
          }

          // Submitted — not confirmed but clicked
          return false;
        }
      } catch (err) {
        logger.debug(`[FormFiller] Submit selector "${sel}" error: ${err.message}`);
      }
    }

    logger.warn('[FormFiller] No submit button found');
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy fillFormSmart export — keeps worker.js and linkedinWorker.js working
// ─────────────────────────────────────────────────────────────────────────────

/**
 * fillFormSmart — Smart form filler with Learning List priority.
 *
 * Resolution order per field:
 *   1. DB learning_questions  (best match to label/placeholder/name)
 *   2. Profile rule-map       (known field patterns → profile values)
 *   3. Skip
 *
 * @param {import('playwright').Page} page
 * @param {object} config - { profile, scopeSelector, blockResumeUpload, resumePath, db }
 */
async function fillFormSmart(page, config = {}) {
  const { profile = {}, scopeSelector, blockResumeUpload, resumePath, db } = config;

  // ── 1. Extract all visible form fields ──────────────────────────────────
  const filler   = new FormFiller(page, profile, config);
  const snapshot = await filler.extractFormSnapshot().catch(() => []);

  const filledSelectors = new Set();

  // ── 2. Learning List pass ────────────────────────────────────────────────
  if (db && snapshot.length > 0) {
    let learningRows = [];
    try {
      // Prefer getAllLearning(); fallback to generic query
      if (typeof db.getAllLearning === 'function') {
        learningRows = db.getAllLearning() || [];
      } else if (typeof db.getLearningList === 'function') {
        learningRows = db.getLearningList() || [];
      } else if (db.db) {
        // Direct better-sqlite3 access
        learningRows = db.db.prepare(
          'SELECT question, answer FROM learning_questions WHERE answered = 1'
        ).all();
      }
    } catch (e) {
      logger.debug('[FormFiller] learning list fetch error: ' + e.message);
    }

    if (learningRows.length > 0) {
      for (const field of snapshot) {
        // Build a text signature for this field
        const fieldText = [field.label, field.placeholder, field.name, field.id]
          .map(s => (s || '').toLowerCase().trim())
          .filter(Boolean)
          .join(' ');

        if (!fieldText) continue;

        // Find best matching Q&A
        let bestAnswer = null;
        let bestScore  = 0;

        for (const row of learningRows) {
          if (!row.answer) continue;
          const qWords = (row.question || '').toLowerCase().split(/\W+/).filter(w => w.length > 2);
          if (qWords.length === 0) continue;

          const matched = qWords.filter(w => fieldText.includes(w)).length;
          const score   = matched / qWords.length;

          if (score > bestScore) { bestScore = score; bestAnswer = row.answer; }
        }

        if (bestScore >= 0.4 && bestAnswer) {
          logger.debug(`[FormFiller] Learning match (${Math.round(bestScore*100)}%) "${fieldText}" → "${bestAnswer}"`);
          try {
            if (field.type === 'select') {
              await page.selectOption(field.selector, bestAnswer).catch(async () =>
                page.selectOption(field.selector, { label: bestAnswer }).catch(() => {})
              );
            } else if (field.type === 'radio' || field.type === 'checkbox') {
              // Try to match the option value
              if (field.options && field.options.length > 0) {
                const opt = field.options.find(o =>
                  (o.text || o.value || '').toLowerCase().includes(bestAnswer.toLowerCase())
                );
                if (opt) await page.check(`input[value="${opt.value}"]`).catch(() => {});
              } else {
                await page.check(field.selector).catch(() => {});
              }
            } else {
              const { safeType } = require('./antiDetection');
              await safeType(page, field.selector, bestAnswer);
            }
            filledSelectors.add(field.selector);
            await humanDelay(200, 500);
          } catch (e) {
            logger.debug(`[FormFiller] learning fill error "${field.selector}": ${e.message}`);
          }
        }
      }
    }
  }

  // ── 3. Profile rule-map pass (skip already filled) ──────────────────────
  const FIELD_MAP = {
    // Name
    'input[name*="name" i]':           profile.name     || '',
    'input[id*="name" i]':             profile.name     || '',
    'input[autocomplete="name"]':      profile.name     || '',
    // Email
    'input[type="email"]':             profile.email    || '',
    'input[name*="email" i]':          profile.email    || '',
    // Phone
    'input[type="tel"]':               profile.phone    || '',
    'input[name*="phone" i]':          profile.phone    || '',
    'input[name*="mobile" i]':         profile.phone    || '',
    'input[id*="phone" i]':            profile.phone    || '',
    // LinkedIn / portfolio
    'input[name*="linkedin" i]':       profile.linkedin || profile.linkedIn || '',
    'input[id*="linkedin" i]':         profile.linkedin || profile.linkedIn || '',
    'input[name*="portfolio" i]':      profile.website  || profile.portfolio || '',
    // Location
    'input[name*="city" i]':           profile.currentLocation || '',
    'input[name*="location" i]':       profile.currentLocation || '',
    'input[id*="city" i]':             profile.currentLocation || '',
    // Notice period
    'input[name*="notice" i]':         profile.noticePeriod   || '30',
    'input[id*="notice" i]':           profile.noticePeriod   || '30',
    // Salary
    'input[name*="currentSalary" i]':  profile.salary         || '',
    'input[name*="expectedSalary" i]': profile.expectedSalary || profile.salary || '',
    'input[id*="salary" i]':           profile.salary         || '',
    // Cover letter
    'textarea[name*="cover" i]':       profile.coverLetter    || '',
    'textarea[id*="cover" i]':         profile.coverLetter    || '',
    'textarea':                        profile.coverLetter    || '',
    // Experience years
    'input[name*="experience" i]':     String(profile.yearsExperience || ''),
    'input[id*="experience" i]':       String(profile.yearsExperience || ''),
    // GitHub
    'input[name*="github" i]':         profile.github   || '',
    'input[id*="github" i]':           profile.github   || '',
  };

  for (const [sel, value] of Object.entries(FIELD_MAP)) {
    if (!value) continue;
    try {
      const scopedSel = scopeSelector ? `${scopeSelector} ${sel}` : sel;
      const locator   = page.locator(scopedSel).first();
      if (await locator.count() === 0) continue;
      if (!await locator.isVisible().catch(() => false)) continue;

      // Skip if learning list already filled something matching this selector
      const matchesAlreadyFilled = snapshot.some(f =>
        filledSelectors.has(f.selector) &&
        ['name','id','email','phone'].some(attr =>
          f[attr] && sel.toLowerCase().includes(f[attr].toLowerCase())
        )
      );
      if (matchesAlreadyFilled) continue;

      const tag  = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => 'input');
      const type = await locator.getAttribute('type').catch(() => 'text') || 'text';

      if (tag === 'select') {
        await page.selectOption(scopedSel, value).catch(() => {});
      } else if (type === 'checkbox' || type === 'radio') {
        await locator.check().catch(() => {});
      } else {
        await safeType(page, scopedSel, value);
      }
      await humanDelay(200, 500);
    } catch (_) {}
  }

  // ── 4. Resume upload ─────────────────────────────────────────────────────
  if (!blockResumeUpload && resumePath) {
    await filler.uploadResume(resumePath).catch(() => {});
  }

  return []; // kept for interface compat
}

module.exports = { FormFiller, fillFormSmart };
