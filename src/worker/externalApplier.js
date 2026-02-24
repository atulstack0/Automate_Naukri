'use strict';

/**
 * externalApplier.js
 * Follow external job site redirects and apply intelligently.
 * Uses AI (Ollama) for navigation decisions and success detection.
 */

const path = require('path');
const logger = require('../utils/logger');
const { fillFormSmart } = require('./formFiller');
const { randomDelay, readingPause, backoff, highlightAndClick, highlightElement } = require('../utils/antiDetection');
const { decideNextAction, isApplicationComplete } = require('../ai/aiAgent');


// ──────────────────────────────────────────────────────────────────────────────
// Site detection
// ──────────────────────────────────────────────────────────────────────────────
function detectSiteType(url) {
  logger.debug(`[ExtApply] Detecting site type for URL: ${url}`);
  if (/myworkdayjobs\.com|workday\.com/i.test(url)) {
    logger.info('[ExtApply] Site Type: workday');
    return 'workday';
  }
  if (/greenhouse\.io|boards\.greenhouse/i.test(url)) {
    logger.info('[ExtApply] Site Type: greenhouse');
    return 'greenhouse';
  }
  if (/lever\.co/i.test(url)) {
    logger.info('[ExtApply] Site Type: lever');
    return 'lever';
  }
  if (/smartrecruiters\.com/i.test(url)) {
    logger.info('[ExtApply] Site Type: smartrecruiters');
    return 'smartrecruiters';
  }
  if (/icims\.com/i.test(url)) {
    logger.info('[ExtApply] Site Type: icims');
    return 'icims';
  }
  if (/linkedin\.com\/jobs/i.test(url)) {
    logger.info('[ExtApply] Site Type: linkedin');
    return 'linkedin';
  }
  if (/indeed\.com/i.test(url)) {
    logger.info('[ExtApply] Site Type: indeed');
    return 'indeed';
  }
  if (/taleo\.net/i.test(url)) {
    logger.info('[ExtApply] Site Type: taleo');
    return 'taleo';
  }
  if (/successfactors\.com|sap\.com/i.test(url)) {
    logger.info('[ExtApply] Site Type: successfactors');
    return 'successfactors';
  }
  logger.info('[ExtApply] Site Type: generic');
  return 'generic';
}

// ──────────────────────────────────────────────────────────────────────────────
// Common multi-step helper: keep clicking Next/Continue until done or 10 steps
// ──────────────────────────────────────────────────────────────────────────────
const NEXT_SELECTORS = [
  'button:has-text("Next")',
  'button:has-text("Continue")',
  'button:has-text("Save & Continue")',
  'button:has-text("Save and Continue")',
  'button:has-text("Proceed")',
  '[data-automation-id*="next" i]',
  '[class*="next-btn"]:not([disabled])',
  'button[type="submit"]:has-text("Next")',
];

const SUBMIT_SELECTORS = [
  'button:has-text("Submit")',
  'button:has-text("Apply")',
  'button:has-text("Submit Application")',
  'button:has-text("Send Application")',
  'button[type="submit"]',
  '[data-automation-id*="submit" i]',
  '[class*="submit"]:not([disabled])',
];

const SUCCESS_SELECTORS = [
  '[class*="success"]',
  '[class*="thank"]',
  '[class*="confirmation"]',
  '[class*="submitted"]',
  'text=Application submitted',
  'text=Application received',
  'text=Thank you',
  'text=Successfully applied',
  'text=We have received your application',
  'h1:has-text("Thank")',
  'h2:has-text("Thank")',
];

// Fast DOM check only – NO AI call (used inside loops)
async function isSuccessPage(page) {
  for (const sel of SUCCESS_SELECTORS) {
    try {
      if (await page.locator(sel).count() > 0) {
        logger.info('[ExtApply] Success selector matched');
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// AI-powered final check – only call ONCE after submission, not in every loop
async function finalSuccessCheck(page) {
  if (await isSuccessPage(page)) return true;
  try {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (text.length > 50) return await isApplicationComplete(text);
  } catch (_) {}
  return false;
}

async function clickNext(page) {
  for (const sel of NEXT_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
        await highlightAndClick(page, btn, `Next: ${sel.match(/"([^"]+)"/)?.[1] || 'Next'}`, { timeout: 8000 });
        await randomDelay(800, 1500);
        logger.info(`[ExtApply] Clicked next: "${sel}"`);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function clickSubmit(page) {
  for (const sel of SUBMIT_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
        await highlightAndClick(page, btn, `Submit: ${sel.match(/"([^"]+)"/)?.[1] || 'Submit'}`, { timeout: 8000 });
        await randomDelay(1200, 2200);
        logger.info(`[ExtApply] Clicked submit: "${sel}"`);
        return true;
      }
    } catch (_) {}
  }
  return false;
}


// ──────────────────────────────────────────────────────────────────────────────
// Site-specific handlers
// ──────────────────────────────────────────────────────────────────────────────

async function applyWorkday(page, config) {
  logger.info('[ExtApply] Workday detected');
  // Click "Apply" or "Apply Now" on the job detail page
  const applyBtns = [
    'a:has-text("Apply")', 'button:has-text("Apply")', 'a:has-text("Apply Now")',
    '[data-automation-id="jobPostingApplyButton"]',
  ];
  for (const sel of applyBtns) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        await highlightAndClick(page, btn, 'Apply (Workday)', { timeout: 8000 });
        await randomDelay(2000, 3500);
        break;
      }
    } catch (_) {}
  }

  // Workday uses an iFrame or new pages for the form; handle multi-step
  return await genericMultiStep(page, config);
}

async function applyGreenhouse(page, config) {
  logger.info('[ExtApply] Greenhouse detected');
  // Greenhouse usually has direct apply form on the job page
  return await genericMultiStep(page, config);
}

async function applyLever(page, config) {
  logger.info('[ExtApply] Lever detected');
  // Lever: click "Apply" button if on job detail, then fill form
  try {
    const applyBtn = page.locator('a:has-text("Apply for this job"), button:has-text("Apply")').first();
    if (await applyBtn.count() > 0 && await applyBtn.isVisible()) {
      await highlightAndClick(page, applyBtn, 'Apply (Lever)', { timeout: 8000 });
      await randomDelay(2000, 3000);
    }
  } catch (_) {}
  return await genericMultiStep(page, config);
}

async function applySmartRecruiters(page, config) {
  logger.info('[ExtApply] SmartRecruiters detected');
  try {
    const applyBtn = page.locator('button:has-text("Apply"), [class*="apply-btn"]').first();
    if (await applyBtn.count() > 0 && await applyBtn.isVisible()) {
      await highlightAndClick(page, applyBtn, 'Apply (SmartRecruiters)', { timeout: 8000 });
      await randomDelay(2000, 3000);
    }
  } catch (_) {}
  return await genericMultiStep(page, config);
}

async function applyLinkedIn(page, config) {
  logger.info('[ExtApply] LinkedIn detected');
  // LinkedIn Easy Apply flow
  const easyApplyBtns = [
    'button:has-text("Easy Apply")',
    '.jobs-apply-button',
    '[aria-label*="Easy Apply"]',
  ];
  for (const sel of easyApplyBtns) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        await highlightAndClick(page, btn, 'Easy Apply (LinkedIn)', { timeout: 8000 });
        await randomDelay(2000, 3000);
        break;
      }
    } catch (_) {}
  }

  // LinkedIn modal: fill fields, click Next/Review/Submit
  for (let step = 0; step < 10; step++) {
    if (await isSuccessPage(page)) return 'success';

    const unmatched = await fillFormSmart(page, config).catch(() => []);
    await randomDelay(600, 1200);

    // Check for "Review" button before Submit
    const reviewBtn = page.locator('button:has-text("Review"), button:has-text("Review your application")').first();
    if (await reviewBtn.count() > 0 && await reviewBtn.isVisible()) {
      await highlightAndClick(page, reviewBtn, 'Review (LinkedIn)', { timeout: 8000 });
      await randomDelay(1500, 2500);
      continue;
    }

    if (await clickSubmit(page)) {
      await randomDelay(2000, 3500);
      if (await isSuccessPage(page)) return 'success';
      continue;
    }

    if (!(await clickNext(page))) break;
  }

  return await isSuccessPage(page) ? 'success' : 'failed';
}

async function applyGeneric(page, config) {
  logger.info('[ExtApply] Generic site handler started');
  // Try to find and click any Apply button first
  const applyVariants = [
    'button:has-text("Apply Now")',
    'button:has-text("Apply for this position")',
    'button:has-text("Apply for this job")',
    'a:has-text("Apply Now")',
    'a:has-text("Apply")',
    'button:has-text("Apply")',
    '[class*="apply-btn"]',
    '[id*="apply-btn"]',
  ];

  logger.debug(`[ExtApply] Checking ${applyVariants.length} variants for initial Apply button`);
  for (const sel of applyVariants) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        logger.info(`[ExtApply] Initial Apply match: "${sel}" - Clicking...`);
        await highlightAndClick(page, btn, `Apply (${sel.match(/"([^"]+)"/)?.[1] || 'Generic'})`, { timeout: 8000 });
        await randomDelay(2000, 3000);
        break;
      }
    } catch (_) {}
  }

  return await genericMultiStep(page, config);
}

// Core: generic multi-step form handler (works on most ATS)
async function genericMultiStep(page, config) {
  for (let step = 0; step < 10; step++) {
    logger.info(`[ExtApply] Form step ${step + 1} – URL: ${page.url()}`);

    // Success check
    if (await isSuccessPage(page)) {
      logger.info('[ExtApply] Success page detected ✅');
      return 'success';
    }

    // Fill all visible fields (AI-powered)
    try {
      await fillFormSmart(page, config);
    } catch (err) {
      logger.warn('[ExtApply] fillFormSmart error', { err: err.message });
    }

    await randomDelay(700, 1400);

    // Try submit
    logger.debug('[ExtApply] Checking for Submit buttons...');
    const submitted = await clickSubmit(page);
    if (submitted) {
      logger.info('[ExtApply] Submission clicked, waiting for outcome...');
      await randomDelay(1500, 2500);
      if (await isSuccessPage(page)) return 'success';
      logger.debug('[ExtApply] Success page not reached yet, continuing...');
      continue;
    }

    // Try next
    logger.debug('[ExtApply] Checking for Next/Continue buttons...');
    const advanced = await clickNext(page);
    if (advanced) {
      logger.info('[ExtApply] Advanced to next step');
      continue;
    }

    // ── AI Navigation fallback ────────────────────────────────────────────
    logger.info('[ExtApply] No basic buttons found, invoking AI Navigation fallback');
    try {
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      const aiAction = await decideNextAction(pageText, 'complete job application form');

      if (aiAction.action === 'skip') {
        logger.info(`[ExtApply] AI says done: ${aiAction.reason}`);
        break;
      }

      if (aiAction.action === 'wait') {
        logger.warn(`[ExtApply] AI says wait: ${aiAction.reason} – pausing 30s`);
        await page.waitForTimeout(30000);
        continue;
      }

      if (aiAction.action === 'click' && aiAction.target) {
        logger.info(`[ExtApply] AI navigation: click "${aiAction.target}"`);
        // Highlight using text-based locator, then click
        const textLocator = page.locator(`text=${aiAction.target}`).first();
        const btnLocator  = page.locator(`button, a, [role="button"]`)
          .filter({ hasText: new RegExp(aiAction.target.substring(0, 20), 'i') }).first();

        const primaryLocator = (await textLocator.count() > 0) ? textLocator : btnLocator;
        const clicked = await highlightAndClick(page, primaryLocator, `AI: ${aiAction.target}`, { timeout: 5000 })
          .then(() => true)
          .catch(() => false);

        if (clicked) {
          await randomDelay(1500, 2500);
          logger.info(`[ExtApply] AI navigation click succeeded`);
          continue;
        }
      }
    } catch (err) {
      logger.warn('[ExtApply] AI navigation failed', { err: err.message });
    }

    // No options left
    logger.info('[ExtApply] No next/submit/AI-action found – assuming done');
    break;
  }

  return await isSuccessPage(page) ? 'success' : 'failed';
}

// ──────────────────────────────────────────────────────────────────────────────
// Main entry: apply on an external page
// ──────────────────────────────────────────────────────────────────────────────
async function applyExternal(page, config, retries = 2) {
  const url = page.url();
  const siteType = detectSiteType(url);
  logger.info(`[ExtApply] External site: ${siteType} | ${url}`);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        logger.info(`[ExtApply] Retry ${attempt}/${retries}`);
        await backoff(attempt);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        await randomDelay(2000, 3000);
      }

      await readingPause(page);

      let result;
      switch (siteType) {
        case 'workday':       result = await applyWorkday(page, config);       break;
        case 'greenhouse':    result = await applyGreenhouse(page, config);    break;
        case 'lever':         result = await applyLever(page, config);         break;
        case 'smartrecruiters': result = await applySmartRecruiters(page, config); break;
        case 'linkedin':      result = await applyLinkedIn(page, config);      break;
        default:              result = await applyGeneric(page, config);       break;
      }

      logger.info(`[ExtApply] Result: ${result}`);
      return { status: result, siteType };
    } catch (err) {
      logger.error(`[ExtApply] Attempt ${attempt} error`, { err: err.message });
      if (attempt >= retries) {
        return { status: 'failed', siteType };
      }
    }
  }

  return { status: 'failed', siteType };
}

module.exports = { applyExternal, detectSiteType };
