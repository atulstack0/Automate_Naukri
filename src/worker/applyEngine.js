'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  AutoApply — Universal Job Apply Engine                                  ║
 * ║  src/worker/applyEngine.js                                               ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  Edge cases covered:                                                     ║
 * ║  • CAPTCHA / slider / checkbox challenge detection & graceful pause      ║
 * ║  • Session expiry / login wall detection & re-auth prompt                ║
 * ║  • OTP / 2FA modal pause & resume                                        ║
 * ║  • Multi-step forms (up to 12 steps, dedup per step)                     ║
 * ║  • External redirect tab (opens a new tab / window)                      ║
 * ║  • Already-applied detection (pre and post click)                        ║
 * ║  • Apply button ambiguity (multiple variants, priority-sorted)           ║
 * ║  • Disabled / grayed-out buttons with retry                              ║
 * ║  • Validation errors → re-fill with corrected value                      ║
 * ║  • Rate-limit / anti-bot banners (slow down mode)                        ║
 * ║  • Network errors → exponential backoff + page reload                   ║
 * ║  • Cover letter textarea (platform-specific detection)                   ║
 * ║  • Resume upload (file input detection, PDF preference)                  ║
 * ║  • Radio / checkbox / select autofill (learning list priority)           ║
 * ║  • Chatbot Q&A flow (press Enter, wait for next question)                ║
 * ║  • Success / thank-you modal detection                                   ║
 * ║  • Screenshot at each key transition                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger');
const {
  humanDelay, randomDelay, randomScroll, safeClick, safeType,
  randomMouseMove, patchBrowser,
} = require('../utils/antiDetection');

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FORM_STEPS       = 12;
const CAPTCHA_WAIT_MS      = 45_000;  // 45s for manual CAPTCHA solve
const OTP_WAIT_MS          = 60_000;  // 60s for OTP entry
const RATE_LIMIT_WAIT_MS   = 90_000;  // 90s cool-down on rate-limit
const EXTERNAL_PAGE_MS     = 4_000;   // allow external page to load
const STEP_SETTLE_MS       = [600, 1_200];
const POST_APPLY_SETTLE_MS = [2_000, 3_500];

// ─── Selector Banks ───────────────────────────────────────────────────────────

const SEL = {
  // ── CAPTCHA ───
  captcha: [
    '#captcha-internal', '[id*="captcha" i]', '[class*="captcha" i]',
    '[data-testid*="captcha" i]', 'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]', '[class*="slider-captcha"]',
    '[class*="puzzle"]', '#px-captcha',
  ],

  // ── OTP / 2FA ───
  otp: [
    '[id*="otp" i]', '[name*="otp" i]', '[placeholder*="OTP" i]',
    '[placeholder*="verification code" i]', '[id*="verify-code" i]',
    '[class*="otp-input"]', 'input[autocomplete="one-time-code"]',
  ],

  // ── Login wall — MUST be strict to avoid false positives.
  // Naukri/LinkedIn navbars always have 'Sign in' buttons & /login links.
  // Only treat as login wall when the ENTIRE page is a login wall.
  loginWall: [
    '[class*="authwall"]',
    '[class*="login-modal"][style*="display: block"]',
    '[data-modal="login"]',
    'form[action*="/login"] input[type="password"]',
    'form[action*="/signin"] input[type="password"]',
  ],

  // ── Rate limit ───
  rateLimit: [
    '[class*="rate-limit"]', '[class*="too-many-requests"]',
    'h1:has-text("429")', 'p:has-text("too many requests")',
    '[class*="blocked"]', '[id*="error-page"]',
  ],

  // ── Already applied ───
  alreadyApplied: {
    naukri: [
      '.already-applied', '#already-applied', '[class*="alreadyApplied"]',
      'button:has-text("Applied")', 'text=Already Applied',
      '[class*="apply-status"]:has-text("applied")',
    ],
    linkedin: [
      'span.t-bold:has-text("Applied")',
      '.artdeco-inline-feedback--success:has-text("Applied")',
      'button[aria-label*="Applied"]:disabled',
      'button:has-text("Applied"):disabled',
    ],
    indeed: [
      '[data-testid="indeedApplyButton"][aria-label*="Applied"]',
      'span:has-text("You applied")', '.applied-snackbar',
    ],
    generic: [
      'button:has-text("Applied")', 'text=Already Applied',
      'text=You already applied', '[class*="applied-state"]',
    ],
  },

  // ── Apply buttons ───
  applyBtn: {
    naukri: [
      '#apply-button',
      'button#apply-button',
      'a#apply-button',
      '[data-ga-track*="apply" i]',
      'button:has-text("Apply")',
      'button:has-text("Apply Now")',
      'button:has-text("Apply on company site")',
      'a:has-text("Apply Now")',
      '.apply-button',
      '[class*="apply-btn"]',
    ],
    linkedin: [
      'button.jobs-apply-button',
      'button[aria-label*="Easy Apply"]',
      '.jobs-apply-button--top-card button',
      'button:has-text("Easy Apply")',
      '[data-control-name="jobdetails_topcard_inapply"]',
    ],
    indeed: [
      'button[data-testid="indeedApplyButton"]',
      'button:has-text("Apply now")',
      '.icl-Button--primary:has-text("Apply")',
      '#indeed-apply-button',
      'button:has-text("Apply on company site")',
    ],
    generic: [
      'button:has-text("Apply Now")',
      'button:has-text("Apply for this job")',
      'button:has-text("Submit Application")',
      'a:has-text("Apply Now")',
      '[class*="apply-btn"]:not([disabled])',
      '[id*="apply-btn"]',
      'button[type="submit"]:has-text("Apply")',
    ],
  },

  // ── Modal/Drawer scopes ───
  applyScope: {
    naukri:   ['.apply-modal', '.apply-drawer', '.naukri-drawer', '.df__drawer', '[class*="apply-modal"]'],
    linkedin: ['.jobs-easy-apply-modal', '.artdeco-modal__content'],
    indeed:   ['#indeedApplyModal', '.indeed-apply-widget', '[class*="apply-modal"]'],
    generic:  ['[class*="modal"]:visible', '[class*="drawer"]:visible', '[role="dialog"]'],
  },

  // ── Next / Continue ───
  nextBtn: [
    'button[aria-label="Continue to next step"]',
    'button[aria-label*="Continue"]',
    'button[aria-label*="Next"]',
    'button[aria-label*="Review"]',
    'button:has-text("Review your application")',
    'button:has-text("Save & Next")',
    'button:has-text("Save and Next")',
    'button:has-text("Next")',
    'button:has-text("Continue")',
    'button:has-text("Review")',
    'button:has-text("Save & Continue")',
    '[class*="next-btn"]:not([disabled])',
    '[class*="nextbtn"]:not([disabled])',
  ],

  // ── Submit ───
  submitBtn: [
    'button[aria-label="Submit application"]',
    'button:has-text("Submit application")',
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    'button:has-text("Send")',
    'button:has-text("Send Application")',
    'button[type="submit"]:not(:has-text("Search"))',
    '[class*="submit-btn"]:not([disabled])',
    '[id*="submit-btn"]',
  ],

  // ── Success indicators ───
  success: [
    'h3:has-text("Your application was sent")',
    '[class*="artdeco-modal__header"]:has-text("Application sent")',
    '.artdeco-modal__content:has-text("sent to")',
    'button:has-text("Done")',
    '.success-msg', '.applied-text',
    '[class*="applied"]', '[class*="success"]', '[class*="thank"]',
    'text=Application submitted',
    'text=Applied successfully',
    'text=Thank you for applying',
    'text=Application received',
    'text=Your application has been',
    '[data-testid="applicationSuccessModal"]',
    '.post-apply-message',
  ],

  // ── Cover letter ───
  coverLetter: [
    'textarea[id*="cover" i]', 'textarea[aria-label*="cover letter" i]',
    'textarea[name*="cover" i]', 'textarea[placeholder*="cover" i]',
    'textarea[class*="cover" i]',
  ],

  // ── Dismiss buttons ───
  dismiss: [
    'button[aria-label="Dismiss"]',
    'button[aria-label*="close" i]',
    'button[aria-label*="Close"]',
    '.artdeco-modal__dismiss',
    '[class*="modal-close"]',
    '[class*="close-btn"]',
    'svg[aria-label*="close" i]',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if any of the given selectors match a visible element.
 * Returns the first matching selector string, or null.
 */
async function findFirst(page, selectors, { visible = true } = {}) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        if (!visible || await loc.isVisible().catch(() => false)) return sel;
      }
    } catch (_) {}
  }
  return null;
}

/** Exponential backoff: 2^attempt seconds (cap 30s). */
async function backoff(attempt) {
  const ms = Math.min(2 ** attempt * 1_000, 30_000);
  logger.debug(`[ApplyEngine] Backoff ${ms}ms`);
  await new Promise(r => setTimeout(r, ms));
}

/** Save a screenshot to data/screenshots/<date>/. */
async function screenshot(page, jobId, stage) {
  try {
    const date = new Date().toISOString().split('T')[0];
    const dir  = path.join(process.cwd(), 'data', 'screenshots', date);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${jobId}_${stage}_${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`[Screenshot] ${file}`);
    return file;
  } catch (_) { return null; }
}

/** Detect page-level anomalies (CAPTCHA / OTP / login wall / rate-limit). */
async function detectAnomalies(page) {
  const url = page.url().toLowerCase();

  // 1. CAPTCHA
  if (await findFirst(page, SEL.captcha)) return { type: 'captcha' };

  // 2. OTP
  if (await findFirst(page, SEL.otp)) return { type: 'otp' };

  // 3. Login wall — URL redirect is the most reliable signal.
  //    Only fall back to DOM check for known authwall classes (not nav links).
  const isLoginUrl = /\/(login|signin|auth|account\/login|session\/new)(\?|$|#)/i.test(url);
  if (isLoginUrl) {
    // Make sure there's actually a password field (not just a redirect page)
    const hasPassword = await page.locator('input[type="password"]').count().catch(() => 0);
    if (hasPassword > 0) return { type: 'login' };
  }
  if (await findFirst(page, SEL.loginWall)) return { type: 'login' };

  // 4. Rate limit (URL or content)
  if (url.includes('429') || url.includes('blocked')) return { type: 'rateLimit' };
  if (await findFirst(page, SEL.rateLimit)) return { type: 'rateLimit' };

  return null;
}

/**
 * Handle anomaly detected mid-apply:
 *   captcha  → wait CAPTCHA_WAIT_MS for manual solve
 *   otp      → wait OTP_WAIT_MS for manual OTP entry
 *   login    → emit warning, return 'abort'
 *   rateLimit→ wait RATE_LIMIT_WAIT_MS
 * Returns 'continue' | 'abort'.
 */
async function handleAnomaly(page, anomaly, { jobId, io, emit }) {
  const ts = new Date().toISOString();
  switch (anomaly.type) {
    case 'captcha':
      logger.warn(`[ApplyEngine] CAPTCHA detected — waiting ${CAPTCHA_WAIT_MS / 1000}s for manual solve`);
      if (io) io.emit('bot:log', { level: 'warn', msg: `⚠️ CAPTCHA on ${page.url()} — solve manually`, ts });
      await screenshot(page, jobId, 'captcha');
      await page.waitForTimeout(CAPTCHA_WAIT_MS);
      // Re-check if resolved
      if (await findFirst(page, SEL.captcha)) {
        logger.warn('[ApplyEngine] CAPTCHA still present after wait — aborting job');
        return 'abort';
      }
      return 'continue';

    case 'otp':
      logger.warn(`[ApplyEngine] OTP/2FA detected — waiting ${OTP_WAIT_MS / 1000}s`);
      if (io) io.emit('bot:log', { level: 'warn', msg: '🔐 OTP required — enter it in the browser window', ts });
      await screenshot(page, jobId, 'otp');
      await page.waitForTimeout(OTP_WAIT_MS);
      return 'continue';

    case 'login':
      logger.warn('[ApplyEngine] Login wall detected — re-auth required');
      if (io) io.emit('bot:log', { level: 'error', msg: '🔒 Session expired — run Save Auth again', ts });
      await screenshot(page, jobId, 'login_wall');
      return 'abort';

    case 'rateLimit':
      logger.warn(`[ApplyEngine] Rate limit detected — cooling down ${RATE_LIMIT_WAIT_MS / 1000}s`);
      if (io) io.emit('bot:log', { level: 'warn', msg: `⏳ Rate limit hit — pausing ${RATE_LIMIT_WAIT_MS / 1000}s`, ts });
      await screenshot(page, jobId, 'rate_limit');
      await page.waitForTimeout(RATE_LIMIT_WAIT_MS);
      return 'continue';

    default:
      return 'continue';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Form Step Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fill all radio fieldsets inside a scope.
 * Priority: yes/legally/authorized → profile-matched → first option.
 */
async function fillRadios(page, scope, profile) {
  try {
    const root      = scope ? page.locator(scope).first() : page;
    const fieldsets = root.locator('fieldset');
    const count     = await fieldsets.count();

    for (let i = 0; i < count; i++) {
      try {
        const fs_el  = fieldsets.nth(i);
        const legend = (await fs_el.locator('legend').first().textContent().catch(() => '')).toLowerCase();
        const labels = fs_el.locator('label');
        const nLabels = await labels.count();

        let picked = false;
        for (let j = 0; j < nLabels; j++) {
          const labelText = (await labels.nth(j).textContent().catch(() => '')).toLowerCase();
          const isAffirmative = /\byes\b|authorized|legally|willing|agree|eligible/i.test(labelText);
          const radio = fs_el.locator('input[type="radio"]').nth(j);
          if (isAffirmative || (!picked && j === 0)) {
            if (await radio.count() > 0 && !await radio.isChecked().catch(() => false)) {
              await radio.check().catch(() => {});
              logger.debug(`[FormStep] Radio "${legend}" → "${labelText.trim()}"`);
              picked = isAffirmative;
              if (isAffirmative) break;
            }
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Fill all <select> dropdowns inside a scope using learning list first,
 * then profile values, then smart heuristics.
 */
async function fillSelects(page, scope, profile, db) {
  try {
    const root    = scope ? page.locator(scope).first() : page;
    const selects = root.locator('select');
    const count   = await selects.count();

    // Pre-load learning list once
    let learningRows = [];
    try {
      if (db && typeof db.getLearningQuestions === 'function') {
        learningRows = db.getLearningQuestions(500).filter(r => r.answered && r.answer && r.question);
      }
    } catch (_) {}

    for (let i = 0; i < count; i++) {
      try {
        const sel = selects.nth(i);
        if (!await sel.isVisible().catch(() => false)) continue;

        const opts    = await sel.evaluate(el =>
          Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim() }))
        );
        const current = await sel.inputValue().catch(() => '');
        const placeholder = opts.find(o => /^select|^choose|^--/i.test(o.text));

        // Already set to a non-placeholder value → skip
        if (current && current !== placeholder?.value && opts.find(o => o.value === current && !/^select|^choose/i.test(o.text))) continue;

        // Get label for this select
        const handleEl = await sel.elementHandle().catch(() => null);
        let label = '';
        if (handleEl) {
          label = await page.evaluate(el => {
            if (el.id) {
              const lbl = document.querySelector(`label[for="${el.id}"]`);
              if (lbl) return lbl.textContent.trim();
            }
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
            const p = el.closest('[class*="form-element"], [class*="artdeco"]');
            if (p) {
              const l = p.querySelector('label');
              if (l) return l.textContent.trim();
            }
            return el.name || '';
          }, handleEl).catch(() => '');
        }

        let answer = '';

        // 1. Learning list fuzzy match
        if (learningRows.length > 0 && label) {
          const fieldWords = label.toLowerCase().split(/\W+/).filter(w => w.length > 2);
          let best = 0;
          for (const row of learningRows) {
            const qWords = row.question.toLowerCase().split(/\W+/).filter(w => w.length > 2);
            if (!qWords.length) continue;
            const score = fieldWords.filter(w => qWords.includes(w)).length / Math.max(fieldWords.length, qWords.length);
            if (score > best) { best = score; answer = row.answer; }
          }
          if (best < 0.35) answer = '';
        }

        // 2. Profile heuristics
        if (!answer) {
          const labelL = (label || '').toLowerCase();
          if (/notice|joining|availability/i.test(labelL)) {
            answer = profile.noticePeriod || '30';
          } else if (/country|nationality/i.test(labelL)) {
            answer = profile.country || 'India';
          } else if (/currency/i.test(labelL)) {
            answer = 'INR';
          } else if (/relocat|remote|wfh|hybrid/i.test(labelL)) {
            answer = 'Yes';
          } else if (/gender/i.test(labelL)) {
            answer = profile.gender || 'Male';
          } else if (/experienc.*year|how many year/i.test(labelL)) {
            answer = String(profile.yearsExperience || '3');
          }
        }

        // 3. Yes/No quick match
        if (!answer) {
          const yesOpt = opts.find(o => /^yes$/i.test(o.text.trim()));
          if (yesOpt) answer = yesOpt.text;
        }

        // Match answer to an option
        if (answer) {
          const matched = opts.find(o =>
            o.text.toLowerCase() === answer.toLowerCase() ||
            o.text.toLowerCase().includes(answer.toLowerCase()) ||
            answer.toLowerCase().includes(o.text.toLowerCase())
          );
          if (matched) {
            await sel.selectOption(matched.value).catch(() => {});
            logger.debug(`[FormStep] Select "${label}" → "${matched.text}"`);
            continue;
          }
        }

        // 4. Fallback: pick first non-placeholder
        const firstReal = opts.find(o => o.value && !/^select|^choose|^--|^none|^placeholder/i.test(o.text));
        if (firstReal) {
          await sel.selectOption(firstReal.value).catch(() => {});
          logger.debug(`[FormStep] Select "${label}" → first option "${firstReal.text}"`);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Auto-check consent / terms / data processing checkboxes.
 */
async function fillCheckboxes(page, scope) {
  try {
    const root = scope ? page.locator(scope).first() : page;
    const cbs  = root.locator('input[type="checkbox"]');
    const count = await cbs.count();

    for (let i = 0; i < count; i++) {
      try {
        const cb    = cbs.nth(i);
        if (!await cb.isVisible().catch(() => false)) continue;

        const label = await cb.evaluate(el => {
          const id  = el.id;
          const lbl = id ? document.querySelector(`label[for="${id}"]`) : null;
          if (lbl) return lbl.textContent.trim();
          const p = el.closest('label');
          if (p) return p.textContent.trim();
          return '';
        }).catch(() => '');

        const isConsent = /agree|consent|terms|condition|policy|privacy|authorize|confirm|accept|certify/i.test(label);
        if (isConsent && !await cb.isChecked().catch(() => false)) {
          await cb.check().catch(() => {});
          logger.debug(`[FormStep] Auto-checked consent: "${label.substring(0, 60)}"`);
          await humanDelay(100, 300);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Fill cover letter textarea if visible and empty.
 */
async function fillCoverLetter(page, scope, coverLetter, profile) {
  const text = coverLetter || (profile && profile.coverLetter) || '';
  if (!text) return;
  try {
    const root = scope ? page.locator(scope).first() : page;
    for (const sel of SEL.coverLetter) {
      const el = root.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
        const existing = await el.inputValue().catch(() => el.innerText().catch(() => ''));
        if (!existing.trim()) {
          await el.fill(text).catch(async () => {
            await el.click().catch(() => {});
            await el.type(text, { delay: 20 });
          });
          logger.info('[FormStep] Cover letter filled');
        }
        return;
      }
    }
  } catch (_) {}
}

/**
 * Upload resume to any visible file input.
 */
async function uploadResume(page, scope, resumePath) {
  if (!resumePath) return false;
  const absPath = path.resolve(process.cwd(), resumePath);
  if (!fs.existsSync(absPath)) {
    logger.warn(`[FormStep] Resume not found: ${absPath}`);
    return false;
  }
  try {
    const root = scope ? page.locator(scope).first() : page;
    const FILE_SELS = [
      'input[type="file"][accept*="pdf"]',
      'input[type="file"][name*="resume" i]',
      'input[type="file"][name*="cv" i]',
      'input[type="file"][id*="resume" i]',
      'input[type="file"]',
    ];
    for (const fSel of FILE_SELS) {
      const el = root.locator(fSel).first();
      if (await el.count() > 0) {
        await el.setInputFiles(absPath);
        logger.info(`[FormStep] Resume uploaded: ${path.basename(absPath)}`);
        await humanDelay(2_000, 3_500);
        return true;
      }
    }
  } catch (e) {
    logger.debug(`[FormStep] Resume upload error: ${e.message}`);
  }
  return false;
}

/**
 * Try to find and click the submit button within an optional scope.
 * Returns true if clicked.
 */
async function clickSubmit(page, scope) {
  const root = scope ? page.locator(scope).first() : page;
  for (const sel of SEL.submitBtn) {
    try {
      const btn = root.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await humanDelay(200, 500);
        await btn.click({ timeout: 10_000 });
        logger.info(`[ApplyEngine] Submit clicked: "${sel}"`);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

/**
 * Try to find and click the Next/Continue button.
 * Returns true if clicked.
 */
async function clickNext(page, scope) {
  const root = scope ? page.locator(scope).first() : page;
  for (const sel of SEL.nextBtn) {
    try {
      const btn = root.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await humanDelay(150, 400);
        await btn.click({ timeout: 8_000 });
        logger.info(`[ApplyEngine] Next clicked: "${sel}"`);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

/**
 * Check if a success indicator is visible anywhere on the page.
 */
async function checkSuccess(page) {
  return !!(await findFirst(page, SEL.success));
}

/**
 * Dismiss any modal that's still open (e.g. LinkedIn success modal).
 */
async function dismissModal(page) {
  for (const sel of SEL.dismiss) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await humanDelay(500, 800);
        return;
      }
    } catch (_) {}
  }
}

/**
 * Detect validation error messages in the current form step scoped area.
 * Returns list of { selector, message } for fields with errors.
 */
async function detectValidationErrors(page, scope) {
  try {
    const root = scope ? page.locator(scope).first() : page;
    return await root.evaluate(el => {
      const errors = [];
      const errorEls = el.querySelectorAll(
        '[class*="error"]:not([class*="no-error"]), [aria-invalid="true"], ' +
        '.artdeco-inline-feedback--error, [id*="error-for"], [role="alert"]'
      );
      for (const e of errorEls) {
        const text = e.textContent?.trim();
        if (text && text.length > 3) {
          errors.push({ message: text.substring(0, 120) });
        }
      }
      return errors;
    });
  } catch (_) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// fillFormSmart — import existing advanced filler with learning list
// ─────────────────────────────────────────────────────────────────────────────
let _formFillFn;
try {
  ({ fillFormSmart: _formFillFn } = require('./formFiller'));
} catch (_) {
  _formFillFn = async () => [];
}

async function fillStep(page, scope, config, db) {
  const { profile = {}, coverLetter, resumePath } = config;

  // 1. Smart fill (learning list + AI + keyword FIELD_MAP)
  const unmatched = await _formFillFn(page, {
    ...config,
    scopeSelector: scope,
    db,
    blockResumeUpload: false,
  }).catch(() => []);

  // 2. Radio buttons (Naukri / LinkedIn specific)
  await fillRadios(page, scope, profile);

  // 3. Selects with learning list lookup
  await fillSelects(page, scope, profile, db);

  // 4. Consent checkboxes
  await fillCheckboxes(page, scope);

  // 5. Cover letter
  await fillCoverLetter(page, scope, coverLetter, profile);

  return unmatched;
}

// ─────────────────────────────────────────────────────────────────────────────
// External Tab Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * If a new browser tab was opened (external redirect), attempt to apply there.
 * Returns { handled: bool, status: 'success'|'failed'|'skipped' }
 */
async function handleExternalTab(page, jobId, config, db, io) {
  const pages = page.context().pages();
  if (pages.length < 2) return { handled: false };

  const newTab = pages[pages.length - 1];
  const extUrl = newTab.url();

  // Skip obvious blank / same-domain tabs
  const isBlank   = extUrl === 'about:blank' || extUrl === '';
  const isSameSrc = extUrl.includes('naukri.com') && jobId.includes('NK');

  if (isBlank || isSameSrc) return { handled: false };

  logger.info(`[ApplyEngine] External tab: ${extUrl}`);
  if (io) io.emit('bot:log', { level: 'info', msg: `🔗 External apply: ${extUrl}`, ts: new Date().toISOString() });
  await screenshot(newTab, jobId, 'external_opened');

  // Let it load
  await newTab.waitForLoadState('domcontentloaded', { timeout: EXTERNAL_PAGE_MS }).catch(() => {});
  await humanDelay(2_000, 3_000);

  // Anomaly check
  const anomaly = await detectAnomalies(newTab);
  if (anomaly) {
    const decision = await handleAnomaly(newTab, anomaly, { jobId, io, emit: io?.emit.bind(io) });
    if (decision === 'abort') {
      await newTab.close().catch(() => {});
      return { handled: true, status: 'failed', reason: `External anomaly: ${anomaly.type}` };
    }
  }

  // Try to apply on external page
  let status = 'failed';
  try {
    // Patch anti-detection
    await patchBrowser(newTab).catch(() => {});

    // Fill entire form
    const unmatched = await fillStep(newTab, null, config, db);

    // Upload resume
    await uploadResume(newTab, null, config.resumePath);

    // Submit
    const submitted = await clickSubmit(newTab, null);
    if (submitted) {
      await humanDelay(...POST_APPLY_SETTLE_MS);
      const success = await checkSuccess(newTab);
      status = success ? 'success' : 'submitted';
      await screenshot(newTab, jobId, success ? 'external_success' : 'external_submitted');
    } else {
      await screenshot(newTab, jobId, 'external_no_submit');
    }
  } catch (err) {
    logger.debug(`[ApplyEngine] External tab error: ${err.message}`);
    await screenshot(newTab, jobId, 'external_error');
  }

  await newTab.close().catch(() => {});
  return { handled: true, status, extUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Apply Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply to a single job on the current page.
 *
 * @param {import('playwright').Page} page
 * @param {object} job     — { jobId, title, company, url, portal }
 * @param {object} config  — full config.json + { coverLetter, db, io }
 * @param {object} opts
 * @param {number}   opts.maxRetries  — retry attempts (default 2)
 * @param {string}   opts.portal      — 'naukri'|'linkedin'|'indeed'|'generic'
 * @param {object}   opts.db          — DB singleton
 * @param {object}   opts.io          — socket.io instance
 *
 * @returns {Promise<{
 *   status: 'success'|'failed'|'already_applied'|'external'|'skipped',
 *   steps:  number,
 *   reason: string,
 *   unmatched: Array
 * }>}
 */
async function applyToJob(page, job, config, opts = {}) {
  const {
    maxRetries = 2,
    portal     = 'generic',
    db         = null,
    io         = null,
  } = opts;

  const { jobId, title = 'Job', company = 'Company' } = job;
  const emit = (ev, data) => { if (io) io.emit(ev, data); };
  const ts   = () => new Date().toISOString();

  // ── Pre-check: already applied ──────────────────────────────────────────────
  const alreadySelectors = [
    ...(SEL.alreadyApplied[portal]  || []),
    ...(SEL.alreadyApplied.generic  || []),
  ];
  if (await findFirst(page, alreadySelectors)) {
    logger.info(`[ApplyEngine] Already applied (pre-check): "${title}"`);
    return { status: 'already_applied', steps: 0, reason: 'Already-applied badge', unmatched: [] };
  }

  const applySelectors = SEL.applyBtn[portal] || SEL.applyBtn.generic;
  const scopeVariants  = SEL.applyScope[portal] || SEL.applyScope.generic;

  let lastResult = { status: 'failed', steps: 0, reason: 'No attempts', unmatched: [] };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        logger.info(`[ApplyEngine] Retry ${attempt}/${maxRetries} for "${title}"`);
        await backoff(attempt);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 25_000 });
        await humanDelay(2_000, 3_500);
      }

      // ── Anomaly check ─────────────────────────────────────────────────────
      const anomaly = await detectAnomalies(page);
      if (anomaly) {
        const decision = await handleAnomaly(page, anomaly, { jobId, io, emit });
        if (decision === 'abort') return { ...lastResult, reason: `Anomaly: ${anomaly.type}` };
      }

      // ── Already applied (post-reload) ─────────────────────────────────────
      if (await findFirst(page, alreadySelectors)) {
        return { status: 'already_applied', steps: 0, reason: 'Badge', unmatched: [] };
      }

      // ── Find and click Apply button ───────────────────────────────────────
      let applyClicked = false;
      for (const sel of applySelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
            // Check if disabled — attempt to detect why
            const disabled = await btn.isDisabled().catch(() => false);
            if (disabled) {
              logger.debug(`[ApplyEngine] Apply button disabled: "${sel}" — checking reason`);
              // May be already applied
              if (await findFirst(page, alreadySelectors)) {
                return { status: 'already_applied', steps: 0, reason: 'Disabled apply btn', unmatched: [] };
              }
              continue; // try next selector
            }

            await btn.scrollIntoViewIfNeeded().catch(() => {});
            await randomMouseMove(page).catch(() => {});
            await humanDelay(200, 600);
            await btn.click({ timeout: 10_000 });
            applyClicked = true;
            await humanDelay(...STEP_SETTLE_MS);
            logger.info(`[ApplyEngine] Apply clicked: "${sel}"`);
            emit('bot:log', { level: 'info', msg: `🖱 Clicked Apply for "${title}"`, ts: ts() });
            break;
          }
        } catch (err) {
          logger.debug(`[ApplyEngine] Selector "${sel}" error: ${err.message}`);
        }
      }

      if (!applyClicked) {
        logger.warn(`[ApplyEngine] No apply button found for "${title}" (attempt ${attempt})`);
        if (attempt >= maxRetries) return { status: 'failed', steps: 0, reason: 'No apply button', unmatched: [] };
        continue;
      }

      // ── Post-click anomaly / already-applied ──────────────────────────────
      await humanDelay(400, 800);
      if (await findFirst(page, alreadySelectors)) {
        return { status: 'already_applied', steps: 0, reason: 'Badge (post-click)', unmatched: [] };
      }
      const postAnomaly = await detectAnomalies(page);
      if (postAnomaly) {
        const decision = await handleAnomaly(page, postAnomaly, { jobId, io, emit });
        if (decision === 'abort') return { ...lastResult, reason: `Post-click anomaly: ${postAnomaly.type}` };
      }

      // ── External tab check ────────────────────────────────────────────────
      await humanDelay(600, 1_200); // let navigation start
      const extResult = await handleExternalTab(page, jobId, config, db, io);
      if (extResult.handled) {
        return {
          status:    extResult.status,
          steps:     0,
          reason:    extResult.extUrl ? `External: ${extResult.extUrl}` : 'External redirect',
          unmatched: [],
        };
      }

      // ── Multi-step form loop ──────────────────────────────────────────────
      await screenshot(page, jobId, `apply_opened_a${attempt}`);

      // Find first matching scope selector
      let scopeSelector = null;
      for (const s of scopeVariants) {
        try {
          const loc = page.locator(s).first();
          if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
            scopeSelector = s;
            break;
          }
        } catch (_) {}
      }

      let allUnmatched = [];
      let stepCount    = 0;
      let formDone     = false;
      let blockResume  = false;
      let consecutiveValidationErrors = 0;

      for (let step = 0; step < MAX_FORM_STEPS; step++) {
        stepCount = step + 1;
        logger.info(`[ApplyEngine] Form step ${stepCount} / portal: ${portal}`);
        emit('bot:log', { level: 'info', msg: `📋 Form step ${stepCount} for "${title}"`, ts: ts() });

        // Anomaly check inside form loop
        const stepAnomaly = await detectAnomalies(page);
        if (stepAnomaly) {
          const d = await handleAnomaly(page, stepAnomaly, { jobId, io, emit });
          if (d === 'abort') { formDone = false; break; }
        }

        // Fill fields
        const stepUnmatched = await fillStep(page, scopeSelector, config, db).catch(() => []);
        if (stepUnmatched.chatbotInteracted) blockResume = true;
        if (!blockResume) await uploadResume(page, scopeSelector, config.resumePath);
        allUnmatched.push(...(Array.isArray(stepUnmatched) ? stepUnmatched : []));

        await humanDelay(...STEP_SETTLE_MS);

        // Check validation errors
        const validationErrs = await detectValidationErrors(page, scopeSelector);
        if (validationErrs.length > 0) {
          logger.warn(`[ApplyEngine] Step ${stepCount} validation errors: ${validationErrs.map(e => e.message).join(' | ')}`);
          consecutiveValidationErrors++;
          if (consecutiveValidationErrors >= 3) {
            logger.error(`[ApplyEngine] Stuck on validation errors for 3 consecutive steps. Proceeding anyway to avoid infinite loop.`);
            consecutiveValidationErrors = 0; // reset so next step is fresh
            // Fall through to Next/Submit \u2014 do NOT loop again
          } else {
            // Do ONE targeted re-fill only \u2014 never blindly re-fill in a loop
            logger.info(`[ApplyEngine] Step ${stepCount}: doing single re-fill (attempt ${consecutiveValidationErrors})`);
            await fillStep(page, scopeSelector, { ...config, blockResumeUpload: true }, db).catch(() => {});
            await humanDelay(600, 1000);
            // Fall through to Next — do NOT continue here
          }
        } else {
          consecutiveValidationErrors = 0;
        }

        // Mid-step success check
        if (await checkSuccess(page)) {
          formDone = true;
          logger.info(`[ApplyEngine] Success detected at step ${stepCount}`);
          await screenshot(page, jobId, `success_step_${stepCount}`);
          break;
        }

        // Try submit → if clicked, verify success
        const didSubmit = await clickSubmit(page, scopeSelector);
        if (didSubmit) {
          await humanDelay(...POST_APPLY_SETTLE_MS);

          // Post-submit success check (try a few times)
          for (let check = 0; check < 3; check++) {
            if (await checkSuccess(page)) { formDone = true; break; }
            await humanDelay(800, 1_200);
          }

          if (!formDone) {
            // URL might have changed (redirect to confirmation)
            const curUrl = page.url();
            if (/thank|confirm|success|applied|done|submitted/i.test(curUrl)) {
              formDone = true;
            }
          }

          await screenshot(page, jobId, formDone ? `submitted_${stepCount}` : `submit_nack_${stepCount}`);
          break; // either done or truly failed — stop stepping
        }

        // Try Next / Continue
        const didNext = await clickNext(page, scopeSelector);
        if (!didNext) {
          if (stepUnmatched.chatbotInteracted) {
            // Chatbot flow — keep looping
            continue;
          }
          logger.warn(`[ApplyEngine] No Next/Submit at step ${stepCount} — stopping`);
          break;
        }

        await humanDelay(...STEP_SETTLE_MS);

        // Re-detect scope after navigation (modal may have changed class)
        for (const s of scopeVariants) {
          try {
            const loc = page.locator(s).first();
            if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
              scopeSelector = s; break;
            }
          } catch (_) {}
        }
      } // end form loop

      // ── Final check ───────────────────────────────────────────────────────
      if (!formDone) formDone = await checkSuccess(page);

      // LinkedIn "Done" button
      try {
        const done = page.locator('button:has-text("Done")').first();
        if (await done.count() > 0 && await done.isVisible().catch(() => false)) {
          await done.click().catch(() => {});
          formDone = true;
        }
      } catch (_) {}

      // Dismiss residual modal
      await dismissModal(page);

      await screenshot(page, jobId, formDone ? 'final_success' : 'final_failed');

      lastResult = {
        status:    formDone ? 'success' : 'failed',
        steps:     stepCount,
        reason:    formDone ? 'Completed' : `Form not completed (${stepCount} steps)`,
        unmatched: allUnmatched,
      };

      if (formDone) return lastResult;

      // If we got here without success, try again on next iteration
    } catch (err) {
      logger.error(`[ApplyEngine] Attempt ${attempt} error: ${err.message}`, { stack: err.stack });
      await screenshot(page, jobId, `error_a${attempt}`).catch(() => {});
      lastResult = { status: 'failed', steps: 0, reason: err.message, unmatched: [] };
      if (attempt >= maxRetries) return lastResult;
    }
  }

  return lastResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Scoring Helper (wraps AI or NullAI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a job using the provided AI client or fall back to keyword matching.
 * Returns { score, decision, reason }.
 */
async function scoreJob(ai, job, config) {
  const keywords = [
    ...(config.keywords?.required  || []),
    ...(config.keywords?.preferred || []),
    ...(config.searchKeywords      || []),
  ];

  try {
    if (ai && typeof ai.scoreJob === 'function') {
      return await ai.scoreJob({
        title:       job.title,
        company:     job.company,
        location:    job.location,
        description: job.description || '',
        keywords,
        profile:     config.profile || {},
      });
    }
  } catch (err) {
    logger.warn(`[ApplyEngine] AI scoreJob failed: ${err.message}`);
  }

  // Keyword fallback
  const text    = `${job.description || ''} ${job.title || ''} ${job.company || ''}`.toLowerCase();
  const hits    = keywords.filter(k => k && text.includes(k.toLowerCase())).length;
  const score   = keywords.length ? Math.round((hits / keywords.length) * 100) : 50;
  const threshold = Number(config.scoreThreshold) || 40;
  const decision  = score >= threshold ? 'APPLY' : 'SKIP';
  return { score, decision, reason: `keyword (${hits}/${keywords.length})` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  applyToJob,
  scoreJob,
  detectAnomalies,
  handleAnomaly,
  fillStep,
  fillRadios,
  fillSelects,
  fillCheckboxes,
  fillCoverLetter,
  uploadResume,
  clickSubmit,
  clickNext,
  checkSuccess,
  dismissModal,
  detectValidationErrors,
  handleExternalTab,
  screenshot,
  SEL,
};
