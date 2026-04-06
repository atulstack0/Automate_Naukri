'use strict';

/**
 * externalApplier.js
 * Site-specific job application handlers.
 * Workday: uses exact data-automation-id selectors discovered via live browser inspection.
 * React-compatible field filling using dispatchEvent to trigger framework validation.
 */

const logger = require('../utils/logger');
const { fillFormSmart } = require('./formFiller');
const { randomDelay, readingPause, backoff, highlightAndClick } = require('../utils/antiDetection');
const { decideNextAction, isApplicationComplete } = require('../ai/aiAgent');

// ─────────────────────────────────────────────────────────────────────────────
// Site detection
// ─────────────────────────────────────────────────────────────────────────────
function detectSiteType(url) {
  if (/myworkdayjobs\.com|workday\.com/i.test(url))   { logger.info('[ExtApply] Site Type: workday');          return 'workday'; }
  if (/greenhouse\.io|boards\.greenhouse/i.test(url)) { logger.info('[ExtApply] Site Type: greenhouse');       return 'greenhouse'; }
  if (/lever\.co/i.test(url))                         { logger.info('[ExtApply] Site Type: lever');            return 'lever'; }
  if (/smartrecruiters\.com/i.test(url))              { logger.info('[ExtApply] Site Type: smartrecruiters'); return 'smartrecruiters'; }
  if (/icims\.com/i.test(url))                        { logger.info('[ExtApply] Site Type: icims');            return 'icims'; }
  if (/linkedin\.com\/jobs/i.test(url))               { logger.info('[ExtApply] Site Type: linkedin');         return 'linkedin'; }
  if (/indeed\.com/i.test(url))                       { logger.info('[ExtApply] Site Type: indeed');           return 'indeed'; }
  if (/taleo\.net/i.test(url))                        { logger.info('[ExtApply] Site Type: taleo');            return 'taleo'; }
  if (/successfactors\.com|sap\.com/i.test(url))      { logger.info('[ExtApply] Site Type: successfactors'); return 'successfactors'; }
  logger.info('[ExtApply] Site Type: generic');
  return 'generic';
}

// ─────────────────────────────────────────────────────────────────────────────
// React-compatible input filler
// Standard .fill() doesn't trigger React/Angular validation → button stays disabled.
// This dispatches native input + change events that React listens to.
// ─────────────────────────────────────────────────────────────────────────────
async function reactFill(page, selector, value) {
  try {
    await page.evaluate(({ sel, val }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, val);
      } else {
        el.value = val;
      }
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur',   { bubbles: true }));
    }, { sel: selector, val: value });
    await randomDelay(200, 400);
    return true;
  } catch (e) {
    logger.debug(`[ExtApply] reactFill failed for ${selector}: ${e.message}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic helpers used by non-Workday handlers
// ─────────────────────────────────────────────────────────────────────────────
const NEXT_SELECTORS = [
  'button[data-automation-id="pageFooterNextButton"]',
  'button:has-text("Next")', 'button:has-text("Continue")',
  'button:has-text("Save & Continue")', 'button:has-text("Save and Continue")',
  'button:has-text("Proceed")',
];
const SUBMIT_SELECTORS = [
  'button[data-automation-id="pageFooterNextButton"]:has-text("Submit")',
  'button:has-text("Submit")', 'button:has-text("Apply")',
  'button:has-text("Submit Application")', 'button:has-text("Send Application")',
  'button[type="submit"]',
];
const SUCCESS_SELECTORS = [
  '[data-automation-id="confirmation-of-submission"]',
  ':text("Application Submitted")', ':text("Thank you for applying")',
  ':text("successfully submitted")', ':text("Your application has been submitted")',
  '[class*="success"]', '[class*="thank"]', '[class*="confirmation"]',
  'h1:has-text("Thank")', 'h2:has-text("Thank")',
];

async function isSuccessPage(page) {
  for (const sel of SUCCESS_SELECTORS) {
    try { if (await page.locator(sel).count() > 0) { logger.info('[ExtApply] ✅ Success selector matched'); return true; } } catch (_) {}
  }
  return false;
}

async function clickNext(page) {
  for (const sel of NEXT_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
        await btn.click({ timeout: 8000 });
        await randomDelay(1000, 2000);
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
        await btn.click({ timeout: 8000 });
        await randomDelay(1500, 2500);
        logger.info(`[ExtApply] Clicked submit: "${sel}"`);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKDAY — Complete multi-step application handler
// Discovered selectors from live browser inspection of wk.wd3.myworkdayjobs.com
// ─────────────────────────────────────────────────────────────────────────────
async function applyWorkday(page, config) {
  logger.info('[ExtApply] Workday — full flow starting...');
  const profile = config.profile || {};

  // Consistent password: deterministic so sign-in works on retry
  const wdPassword = config.workdayPassword
    || `${(profile.email || 'user').split('@')[0].replace(/[^a-zA-Z0-9]/g, '')}@AutoApply1`;

  // ── WAIT for SPA to fully render ──────────────────────────────────────────
  await page.waitForSelector(
    '[data-automation-id="adventureButton"], [data-automation-id="jobPostingApplyButton"], h1',
    { timeout: 25000 }
  ).catch(() => logger.warn('[ExtApply] Workday: SPA wait timed out — continuing'));
  await randomDelay(2000, 3000);

  // Already applied?
  const already = await page.locator('[data-automation-id="alreadyApplied"]').count().catch(() => 0);
  if (already > 0) { logger.info('[ExtApply] Already applied to this job'); return 'success'; }

  // ── STEP 1: Click the Apply button ────────────────────────────────────────
  // Confirmed selector: a[data-automation-id="adventureButton"]
  const applyBtnSelectors = [
    '[data-automation-id="adventureButton"]',
    '[data-automation-id="jobPostingApplyButton"]',
    'button:has-text("Apply Now")', 'a:has-text("Apply Now")',
    'button:has-text("Apply")',
  ];
  let clicked = false;
  for (const sel of applyBtnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        await btn.click({ timeout: 8000 });
        await randomDelay(2500, 4000);
        clicked = true;
        logger.info(`[ExtApply] Workday: Apply button clicked (${sel})`);
        break;
      }
    } catch (_) {}
  }
  if (!clicked) logger.warn('[ExtApply] Workday: No Apply button found — trying to continue anyway');

  // ── STEP 2: Handle "Start Your Application" modal ─────────────────────────
  // Confirmed selector: a[data-automation-id="applyManually"]
  await randomDelay(1500, 2500);
  let modalHandled = false;

  // Check if account already exists (Workday detects existing email → shows sign-in)
  // If "Use My Last Application" is visible → user is already signed in
  try {
    const lastApp = page.locator('[data-automation-id="useLastApplication"], button:has-text("Use My Last Application")').first();
    if (await lastApp.count() > 0 && await lastApp.isVisible({ timeout: 2000 }).catch(() => false)) {
      await lastApp.click({ timeout: 8000 });
      modalHandled = true;
      logger.info('[ExtApply] Workday: clicked "Use My Last Application"');
      await randomDelay(2000, 3000);
    }
  } catch (_) {}

  if (!modalHandled) {
    // Click "Apply Manually" — confirmed: a[data-automation-id="applyManually"]
    const manualSelectors = [
      '[data-automation-id="applyManually"]',
      'button:has-text("Apply Manually")',
      ':text("Apply Manually")',
    ];
    for (const sel of manualSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible({ timeout: 5000 }).catch(() => false)) {
          await el.click({ timeout: 8000 });
          modalHandled = true;
          logger.info('[ExtApply] Workday: modal → clicked "Apply Manually"');
          await randomDelay(2500, 4000);
          break;
        }
      } catch (_) {}
    }
  }

  if (!modalHandled) logger.warn('[ExtApply] Workday: modal not detected — proceeding with current page');

  // Wait for navigation to the apply form
  await page.waitForURL(/\/apply\//i, { timeout: 20000 }).catch(() =>
    logger.warn('[ExtApply] Workday: URL did not change to /apply/'));
  await randomDelay(2000, 3000);
  logger.info(`[ExtApply] Workday: apply page URL: ${page.url().substring(0, 100)}`);

  // ── Shared Workday navigation buttons ─────────────────────────────────────
  // Confirmed Next/Continue button: button[data-automation-id="pageFooterNextButton"]
  const WD_NEXT_BTN   = '[data-automation-id="pageFooterNextButton"]';
  const WD_SUBMIT_BTN = '[data-automation-id="pageFooterNextButton"]'; // same element, labeled "Submit" on last page

  const WD_SUCCESS_INDICATORS = [
    '[data-automation-id="confirmation-of-submission"]',
    ':text("Application Submitted")',
    ':text("Thank you for applying")',
    ':text("Your application has been submitted")',
    ':text("We have received your application")',
  ];

  async function isWdDone() {
    for (const s of WD_SUCCESS_INDICATORS) {
      try { if (await page.locator(s).count() > 0) return true; } catch (_) {}
    }
    return false;
  }

  // ── CHECK if already on sign-in page (email already registered) ────────────
  async function handleSignInIfNeeded() {
    // Specifically look for the Sign In button to differentiate from Create Account
    const isSignIn = await page.locator('[data-automation-id="signInBtn"], button:text("Sign In")').count().catch(() => 0);
    if (isSignIn > 0) {
      logger.info('[ExtApply] Workday: Existing account detected — signing in');
      await reactFill(page, '[data-automation-id="signInEmail"], input[data-automation-id="email"]', profile.email || '');
      await reactFill(page, '[data-automation-id="password"], input[data-automation-id="password"]', wdPassword);
      await randomDelay(500, 1000);
      try {
        const signInBtn = page.locator('[data-automation-id="signInBtn"], button:has-text("Sign In")').first();
        if (await signInBtn.count() > 0 && await signInBtn.isVisible().catch(() => false)) {
          await signInBtn.click({ force: true, timeout: 5000 }).catch(async () => {
            logger.info('[ExtApply] Workday: Sign In click intercepted, falling back to Enter');
            await page.locator('[data-automation-id="password"], input[data-automation-id="password"]').press('Enter');
          });
          await randomDelay(3000, 5000);
          logger.info('[ExtApply] Workday: sign-in button clicked');

          // Check if we are STILL on the sign in page (button still visible)
          const stillVisible = await signInBtn.isVisible().catch(() => false);
          if (stillVisible) {
             logger.warn('[ExtApply] Workday: Sign In failed (button still visible) — trying to create fresh account');
             // Workday usually has a 'Create Account' link on the sign in page
             const createLinkSelectors = [
                 '[data-automation-id="createAccountLink"]', 
                 'button:has-text("Create Account")', 
                 'a:has-text("Create Account")',
                 'div[role="button"]:has-text("Create Account")'
             ];
             for (const cl of createLinkSelectors) {
                 const createLink = page.locator(cl).first();
                 if (await createLink.count() > 0 && await createLink.isVisible().catch(() => false)) {
                     await createLink.click({ force: true, timeout: 5000 }).catch(() => {});
                     await randomDelay(2500, 3500);
                     break;
                 }
             }
             // We intentionally return false so the main loop can proceed to `handleCreateAccount`
             return false; 
          }
        }
      } catch (e) {
        logger.warn(`[ExtApply] Workday sign-in error: ${e.message}`);
      }
      return true;
    }
    return false;
  }

  // ── Create Account step ────────────────────────────────────────────────────
  // Confirmed selectors:
  //   input[data-automation-id="email"]
  //   input[data-automation-id="password"]
  //   input[data-automation-id="verifyPassword"]
  //   input[data-automation-id="createAccountCheckbox"]
  //   div[data-automation-id="click_filter"] (Create Account button)
  async function handleCreateAccount() {
    const hasCreateAccountForm = await page.locator(
      '[data-automation-id="createAccountCheckbox"], [data-automation-id="verifyPassword"]'
    ).count().catch(() => 0);
    if (hasCreateAccountForm === 0) return false;

    logger.info('[ExtApply] Workday: Create Account page — filling credentials');

    // Fill email using React-compatible method
    await reactFill(page, 'input[data-automation-id="email"]', profile.email || '');
    await randomDelay(400, 700);

    // Fill password
    await reactFill(page, 'input[data-automation-id="password"]', wdPassword);
    await randomDelay(400, 700);

    // Fill verify password
    await reactFill(page, 'input[data-automation-id="verifyPassword"]', wdPassword);
    await randomDelay(400, 700);

    // Check the Terms & Conditions checkbox
    try {
      const checkbox = page.locator('input[data-automation-id="createAccountCheckbox"]').first();
      if (await checkbox.count() > 0) {
        const checked = await checkbox.isChecked().catch(() => false);
        if (!checked) {
          await checkbox.check({ force: true });
          logger.info('[ExtApply] Workday: Terms checkbox checked');
          await randomDelay(500, 800);
        }
      }
    } catch (_) {}

    // Click "Create Account" button
    const createBtnSelectors = [
      'div[data-automation-id="click_filter"]',
      '[aria-label="Create Account"]',
      'button:has-text("Create Account")',
      '[data-automation-id="createAccountButton"]',
    ];
    for (const sel of createBtnSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
          await btn.click({ force: true, timeout: 8000 });
          logger.info(`[ExtApply] Workday: Create Account clicked (${sel})`);
          await randomDelay(3000, 5000);
          break;
        }
      } catch (_) {}
    }
    return true;
  }

  // ── My Information step ────────────────────────────────────────────────────
  // Confirmed selectors from browser:
  //   input[id="name--legalName--firstName"]
  //   input[id="name--legalName--lastName"]
  //   input[id="address--addressLine1"]
  //   input[id="address--city"]
  //   input[id="address--postalCode"]
  //   input[id="phoneNumber--phoneNumber"]
  async function fillMyInformation() {
    const firstName = (profile.name || '').split(' ')[0] || '';
    const lastName  = (profile.name || '').split(' ').slice(1).join(' ') || '';
    const city      = (profile.currentLocation || '').split(',')[0]?.trim() || '';

    const fields = [
      // Confirmed ID-based selectors
      ['input[id="name--legalName--firstName"]',  firstName],
      ['input[id="name--legalName--lastName"]',   lastName],
      ['input[id="address--addressLine1"]',        profile.currentLocation || ''],
      ['input[id="address--city"]',               city],
      ['input[id="address--postalCode"]',          '411001'],
      ['input[id="phoneNumber--phoneNumber"]',     (profile.phone || '').replace(/\D/g, '').slice(-10)],
      // data-automation-id fallbacks
      ['input[data-automation-id*="firstName" i]', firstName],
      ['input[data-automation-id*="lastName" i]',  lastName],
      ['input[data-automation-id*="phone" i]',     (profile.phone || '').replace(/\D/g, '').slice(-10)],
      ['input[data-automation-id*="linkedin" i]',  profile.linkedIn || ''],
      ['input[data-automation-id*="website" i]',   profile.portfolio || ''],
      // Email
      ['input[data-automation-id="email"]',        profile.email || ''],
      ['input[type="email"]',                      profile.email || ''],
      // Cover letter
      ['textarea[data-automation-id*="coverLetter" i]', profile.coverLetter || ''],
      ['textarea',                                       profile.coverLetter || ''],
    ];

    let filled = 0;
    for (const [sel, value] of fields) {
      if (!value) continue;
      try {
        const el = page.locator(sel).first();
        if (await el.count() === 0) continue;
        if (!await el.isVisible().catch(() => false)) continue;
        const current = await el.inputValue().catch(() => '');
        if (current && current !== '') continue; // don't overwrite

        // React-compatible fill
        const ok = await reactFill(page, sel, value);
        if (ok) {
          filled++;
          await randomDelay(200, 400);
        }
      } catch (_) {}
    }
    logger.info(`[ExtApply] Workday: My Information — filled ${filled} field(s)`);
  }

  // ── Resume upload ──────────────────────────────────────────────────────────
  async function uploadResume() {
    if (!config.resumePath) {
       logger.warn('[ExtApply] Workday: No config.resumePath provided, skipping upload');
       return;
    }
    
    // Attempt 1: Native input
    const fileSelectors = [
      'input[type="file"][data-automation-id*="file-upload"]',
      'input[type="file"][data-automation-id*="resume" i]',
      'input[type="file"][data-automation-id*="upload" i]',
      'input[type="file"]',
      '[data-automation-id="file-upload-input-ref"]'
    ];
    for (const fsel of fileSelectors) {
      try {
        const fi = await page.waitForSelector(fsel, { state: 'attached', timeout: 1500 }).catch(() => null);
        if (fi) {
          await fi.setInputFiles(config.resumePath);
          logger.info(`[ExtApply] Workday: Resume uploaded via native input (${fsel})`);
          await randomDelay(4000, 6000); // wait for upload to complete
          return;
        }
      } catch (e) {}
    }

    // Attempt 2: Click the 'Select file' / drop-zone to trigger OS chooser
    logger.info('[ExtApply] Workday: No native file input found, trying FileChooser intercept');
    try {
      const uploadAreaSelectors = [
        '[data-automation-id="file-upload-drop-zone"]',
        'button:has-text("Select file")',
        'a:has-text("Select file")',
        'span:has-text("Select file")',
        'button:has-text("Upload")',
        'a:has-text("Upload")'
      ];
      
      for (const sel of uploadAreaSelectors) {
         const el = page.locator(sel).first();
         if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
             logger.info(`[ExtApply] Workday: Found upload trigger ${sel}, intercepting OS chooser`);
             const [fileChooser] = await Promise.all([
               page.waitForEvent('filechooser', { timeout: 8000 }),
               el.click({ force: true })
             ]);
             await fileChooser.setFiles(config.resumePath);
             logger.info(`[ExtApply] Workday: Resume uploaded via FileChooser`);
             await randomDelay(4000, 6000);
             return;
         }
      }
      logger.warn('[ExtApply] Workday: Could not find any valid upload trigger element!');
    } catch (e) {
      logger.warn(`[ExtApply] Workday FileChooser error: ${e.message}`);
    }
  }

  // ── Click the page footer Next/Continue/Submit button ──────────────────────
  async function clickPageFooterBtn() {
    // Primary Workday footer button (confirmed: pageFooterNextButton)
    const btn = page.locator(WD_NEXT_BTN).first();
    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
      const isEnabled = await btn.isEnabled().catch(() => false);
      if (!isEnabled) {
        logger.warn('[ExtApply] Workday: Footer button disabled — checking required fields');
        // Try clicking it anyway (sometimes it enables after data entry)
        await btn.click({ force: true, timeout: 5000 }).catch(() => {});
        await randomDelay(1500, 2500);
        return true;
      }
      const text = await btn.textContent().catch(() => 'Next');
      await btn.click({ timeout: 8000 });
      await randomDelay(2500, 4000);
      logger.info(`[ExtApply] Workday: Footer button clicked — "${text?.trim()}"`);
      return true;
    }
    // Fallback selectors
    const fallbacks = [
      'button:has-text("Save and Continue")', 'button:has-text("Save & Continue")',
      'button:has-text("Next")', 'button:has-text("Continue")',
      'button:has-text("Submit")', 'button:has-text("Submit Application")',
    ];
    for (const sel of fallbacks) {
      try {
        const fbBtn = page.locator(sel).first();
        if (await fbBtn.count() > 0 && await fbBtn.isVisible()) {
          await fbBtn.click({ timeout: 8000 });
          await randomDelay(2500, 4000);
          logger.info(`[ExtApply] Workday: footer fallback clicked (${sel})`);
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  // ── MAIN loop — navigate all steps ─────────────────────────────────────────
  for (let step = 0; step < 20; step++) {
    try {
      const url = page.url();
      logger.info(`[ExtApply] Workday step ${step + 1} — ${url.substring(0, 90)}`);

      // Done?
      if (await isWdDone()) {
        logger.info('[ExtApply] Workday: ✅ Application successfully submitted!');
        return 'success';
      }

      // Is there a sign-in form? (happens when email already exists)
      const signedin = await handleSignInIfNeeded();
      if (signedin) { await randomDelay(3000, 5000); continue; }

      // Is there a create-account form?
      const created = await handleCreateAccount();
      if (created) { await randomDelay(3000, 5000); continue; }

      // Fill My Information / other regular steps
      await fillMyInformation();
      await randomDelay(800, 1500);

      // Upload resume on any step that has a file input
      await uploadResume();
      await randomDelay(500, 1000);

      // Navigate to next step
      const advanced = await clickPageFooterBtn();
      if (!advanced) {
        logger.warn(`[ExtApply] Workday: No footer button on step ${step + 1} — stopping`);
        break;
      }
    } catch (loopErr) {
      logger.error(`[ExtApply] Workday: Error in loop step ${step + 1} — ${loopErr.message}`);
      await randomDelay(2000, 3000);
      // Don't break immediately, maybe the page was just reloading
    }
  }

  return (await isWdDone()) ? 'success' : 'failed';
}

// ─────────────────────────────────────────────────────────────────────────────
// Other site handlers
// ─────────────────────────────────────────────────────────────────────────────
async function applyGreenhouse(page, config) {
  logger.info('[ExtApply] Greenhouse detected');
  return await genericMultiStep(page, config);
}

async function applyLever(page, config) {
  logger.info('[ExtApply] Lever detected');
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
  const easyApplyBtns = ['button:has-text("Easy Apply")', '.jobs-apply-button', '[aria-label*="Easy Apply"]'];
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
  for (let step = 0; step < 10; step++) {
    if (await isSuccessPage(page)) return 'success';
    await fillFormSmart(page, config).catch(() => []);
    await randomDelay(600, 1200);
    const reviewBtn = page.locator('button:has-text("Review"), button:has-text("Review your application")').first();
    if (await reviewBtn.count() > 0 && await reviewBtn.isVisible()) {
      await highlightAndClick(page, reviewBtn, 'Review (LinkedIn)', { timeout: 8000 });
      await randomDelay(1500, 2500);
      continue;
    }
    if (await clickSubmit(page)) { await randomDelay(2000, 3500); if (await isSuccessPage(page)) return 'success'; continue; }
    if (!(await clickNext(page))) break;
  }
  return await isSuccessPage(page) ? 'success' : 'failed';
}

async function applyGeneric(page, config) {
  logger.info('[ExtApply] Generic site handler started');
  const applyVariants = [
    'button:has-text("Apply Now")', 'a:has-text("Apply Now")',
    'button:has-text("Apply for this job")', 'button:has-text("Apply")',
    'a:has-text("Apply")', '[class*="apply-btn"]',
  ];
  for (const sel of applyVariants) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        await highlightAndClick(page, btn, `Apply (Generic)`, { timeout: 8000 });
        await randomDelay(2000, 3000);
        break;
      }
    } catch (_) {}
  }
  return await genericMultiStep(page, config);
}

async function genericMultiStep(page, config) {
  for (let step = 0; step < 10; step++) {
    logger.info(`[ExtApply] Form step ${step + 1} – URL: ${page.url()}`);
    if (await isSuccessPage(page)) { logger.info('[ExtApply] ✅ Success page detected'); return 'success'; }
    try { await fillFormSmart(page, config); } catch (err) { logger.warn('[ExtApply] fillFormSmart error', { err: err.message }); }
    await randomDelay(700, 1400);
    if (await clickSubmit(page)) { await randomDelay(1500, 2500); if (await isSuccessPage(page)) return 'success'; continue; }
    if (await clickNext(page))   { logger.info('[ExtApply] Advanced to next step'); continue; }

    // AI Navigation fallback
    logger.info('[ExtApply] No basic buttons — invoking AI fallback');
    try {
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      const aiAction = await decideNextAction(pageText, 'complete job application form');
      if (aiAction.action === 'skip') { logger.info(`[ExtApply] AI says done: ${aiAction.reason}`); break; }
      if (aiAction.action === 'click' && aiAction.target) {
        const loc = page.locator(`text=${aiAction.target}, button:has-text("${aiAction.target}")`).first();
        const ok  = await loc.click({ timeout: 5000 }).then(() => true).catch(() => false);
        if (ok) { await randomDelay(1500, 2500); continue; }
      }
    } catch (err) { logger.warn('[ExtApply] AI navigation failed', { err: err.message }); }

    logger.info('[ExtApply] No navigation found — stopping');
    break;
  }
  return await isSuccessPage(page) ? 'success' : 'failed';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────
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
        case 'workday':         result = await applyWorkday(page, config);         break;
        case 'greenhouse':      result = await applyGreenhouse(page, config);      break;
        case 'lever':           result = await applyLever(page, config);           break;
        case 'smartrecruiters': result = await applySmartRecruiters(page, config); break;
        case 'linkedin':        result = await applyLinkedIn(page, config);        break;
        default:                result = await applyGeneric(page, config);         break;
      }

      logger.info(`[ExtApply] Result: ${result}`);
      return { status: result, siteType };
    } catch (err) {
      logger.error(`[ExtApply] Attempt ${attempt} error: ${err.message}`);
      if (attempt >= retries) return { status: 'failed', siteType };
    }
  }
  return { status: 'failed', siteType };
}

module.exports = { applyExternal, detectSiteType };
