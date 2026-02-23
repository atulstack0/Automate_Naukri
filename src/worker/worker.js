'use strict';

/**
 * worker.js – main orchestration: scrape → AI decide → smart-fill form → apply
 */

const path = require('path');
const fs = require('fs');
const { launchBrowser, closeBrowser } = require('../browser/browser');
const { analyzeJob } = require('../ai/ollamaClient');
const { fillFormSmart } = require('./formFiller');
const { applyExternal } = require('./externalApplier');
const db = require('../db/db');
const logger = require('../utils/logger');
const {
  randomDelay,
  humanClick,
  randomScroll,
  readingPause,
  backoff,
  highlightAndClick,
} = require('../utils/antiDetection');


let emitEvent = () => {};
function setEmitter(fn) { emitEvent = fn; }

// ── Helpers ────────────────────────────────────────────────────────────────

function screenshotPath(jobId, stage) {
  const date = new Date().toISOString().split('T')[0];
  const dir = path.join(process.cwd(), 'data', 'screenshots', date);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${jobId}_${stage}_${Date.now()}.png`);
}

function makeJobId(title, company) {
  return `${title}_${company}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 80) + '_' + Date.now();
}

async function captureScreenshot(page, jobId, stage) {
  try {
    // ── Timestamp ──────────────────────────────────────────────────────────
    const now       = new Date();
    const ts        = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' IST');
    const tsFile    = now.toISOString().replace(/[:T]/g, '-').replace(/\.\d+Z$/, '');

    // Build path with timestamp embedded in filename
    const dir      = path.dirname(screenshotPath(jobId, stage));
    const filePath = path.join(dir, `${jobId}_${stage}_${tsFile}.png`);

    // ── Inject timestamp badge onto the page before screenshot ───────────
    const OVERLAY_ID = '__autoapply_ts_overlay__';
    await page.evaluate(({ id, label }) => {
      const el = document.createElement('div');
      el.id = id;
      el.style.cssText = [
        'position:fixed', 'top:6px', 'right:8px', 'z-index:2147483647',
        'background:rgba(0,0,0,0.72)', 'color:#fff', 'font-size:12px',
        'font-family:monospace', 'padding:3px 8px', 'border-radius:4px',
        'pointer-events:none', 'white-space:nowrap', 'letter-spacing:0.3px',
      ].join(';');
      el.textContent = label;
      document.body.appendChild(el);
    }, { id: OVERLAY_ID, label: `📸 ${ts}` }).catch(() => {});

    await page.screenshot({ path: filePath, fullPage: false });

    // Remove the overlay after screenshot
    await page.evaluate(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    }, OVERLAY_ID).catch(() => {});

    db.saveScreenshot(jobId, stage, filePath);
    return filePath;
  } catch (err) {
    logger.warn(`Screenshot failed [${stage}]`, { err: err.message });
    return null;
  }
}


// ── Naukri Search Flow ─────────────────────────────────────────────────────

/**
 * performNaukriSearch()
 *
 * Selectors confirmed from live naukri.com inspection (Feb 2026):
 *   Keyword input : input.suggestor-input[placeholder*="keyword"]
 *   Location input: input.suggestor-input[placeholder*="location"]
 *   Search button : button.nI-gNb-sb__icon-wrapper
 *
 * Flow:
 *   1. Go to naukri.com
 *   2. If logged in, the search bar is in the header – click the icon to expand it
 *   3. Clear keyword input and type the keyword
 *   4. Clear location input and type location, pick first suggestion
 *   5. Click the Search button (highlighted in red so user can see)
 *   6. Wait for results page and return its URL
 */
async function performNaukriSearch(page, keyword, location = '') {
  logger.info(`\n[Search] ── Searching: "${keyword}" in "${location || 'All India'}" ──`);

  // ── Step 1: Navigate to Naukri homepage ──────────────────────────────────
  await page.goto('https://www.naukri.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await randomDelay(1800, 2800);
  logger.info('[Search] Naukri homepage loaded');

  // ── Step 2: If header search bar is collapsed, click the icon to expand ──
  // (On logged-in view the search bar collapses to an icon in the top nav)
  try {
    const searchIcon = page.locator('div.nI-gNb-sb__icon-wrapper, [class*="nI-gNb-sb__icon"]').first();
    if (await searchIcon.count() > 0 && await searchIcon.isVisible()) {
      await highlightAndClick(page, searchIcon, 'Open Search Bar');
      await randomDelay(600, 1000);
      logger.info('[Search] Expanded header search bar');
    }
  } catch (_) {}

  // ── Step 3: Keyword input ─────────────────────────────────────────────────
  // Primary selector from live inspection; fallbacks for slight DOM variations
  const KEYWORD_SELECTORS = [
    'input.suggestor-input[placeholder*="keyword" i]',
    'input.suggestor-input[placeholder*="designation" i]',
    'input[placeholder*="keyword" i]',
    'input[placeholder*="designation" i]',
    'input[placeholder*="skills" i]',
  ];

  let keywordFilled = false;
  for (const sel of KEYWORD_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible()) {
        await el.click();
        await page.keyboard.shortcut('Control+a');
        await el.fill('');                    // clear existing text
        await el.type(keyword, { delay: 55 });
        logger.info(`[Search] ✏️  Typed keyword: "${keyword}"`);
        await randomDelay(700, 1100);

        // Dismiss any autocomplete with Escape so it doesn't interfere
        await page.keyboard.press('Escape').catch(() => {});
        await randomDelay(300, 500);
        keywordFilled = true;
        break;
      }
    } catch (_) {}
  }

  if (!keywordFilled) {
    logger.warn('[Search] ⚠️  Keyword input not found – using URL fallback');
    const slug    = keyword.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const locSlug = location ? `-in-${location.toLowerCase().replace(/\s+/g, '-')}` : '';
    const url     = `https://www.naukri.com/${slug}-jobs${locSlug}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    logger.info(`[Search] Fallback URL: ${url}`);
    return url;
  }

  // ── Step 4: Location input ────────────────────────────────────────────────
  if (location) {
    const LOCATION_SELECTORS = [
      'input.suggestor-input[placeholder*="location" i]',
      'input[placeholder*="location" i]',
      'input[placeholder*="city" i]',
    ];

    for (const sel of LOCATION_SELECTORS) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible()) {
          await el.click();
          await el.fill('');
          await el.type(location, { delay: 55 });
          logger.info(`[Search] ✏️  Typed location: "${location}"`);
          await randomDelay(800, 1200);

          // Pick first suggestion from the suggestor dropdown
          const SUGGESTION_SELECTORS = [
            '.suggestor-drop li',
            '.suggestor-wrapper li',
            '[class*="suggestor"] li',
            '[class*="dropdown"] li',
            '[class*="suggestion"] li',
            'ul.dropdown li',
          ];
          let pickedSuggestion = false;
          for (const sug of SUGGESTION_SELECTORS) {
            try {
              const first = page.locator(sug).first();
              if (await first.count() > 0 && await first.isVisible()) {
                await highlightAndClick(page, first, `📍 ${location}`);
                logger.info(`[Search] Picked location suggestion: "${location}"`);
                pickedSuggestion = true;
                break;
              }
            } catch (_) {}
          }
          if (!pickedSuggestion) {
            await page.keyboard.press('Enter').catch(() => {});
          }
          break;
        }
      } catch (_) {}
    }
  }

  await randomDelay(400, 700);

  // ── Step 5: Click Search button ───────────────────────────────────────────
  const SEARCH_BTN_SELECTORS = [
    'button.nI-gNb-sb__icon-wrapper',               // confirmed from live inspection
    'button[class*="nI-gNb-sb"]',
    'button:has-text("Search")',
    '[data-label*="Search" i]',
    'button[type="submit"]',
    '[class*="search-btn"]',
  ];

  let searchClicked = false;
  for (const sel of SEARCH_BTN_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        await highlightAndClick(page, btn, '🔍 Search');
        searchClicked = true;
        logger.info(`[Search] ✅ Clicked Search: "${sel}"`);
        break;
      }
    } catch (_) {}
  }

  if (!searchClicked) {
    // Last resort: press Enter from the keyword input
    logger.warn('[Search] Search button not found – pressing Enter');
    await page.keyboard.press('Enter');
  }

  // ── Step 6: Wait for results ──────────────────────────────────────────────
  await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
  await randomDelay(1500, 2500);

  const resultUrl = page.url();
  logger.info(`[Search] 📋 Results URL: ${resultUrl}`);
  return resultUrl;
}


// ── Apply Flow ─────────────────────────────────────────────────────────────


/**
 * Naukri-aware multi-step apply flow.
 * Handles: Apply button variants, chatbot modals, multi-step forms,
 * "Next" / "Continue" pagination inside apply drawer, external redirects.
 * Returns: { status: 'success'|'failed'|'already_applied'|'external', unmatched[] }
 */
async function applyToJob(page, jobId, config) {
  const { selector = {}, maxRetries = 3 } = config;
  let unmatched = [];

  // Naukri-specific selectors (tried in order)
  const APPLY_BTN_SELECTORS = [
    selector.applyButton,
    '#apply-button',
    'button#apply-button',
    'a#apply-button',
    '[data-ga-track*="apply" i]',
    'button:has-text("Apply")',
    'button:has-text("Apply Now")',
    'a:has-text("Apply Now")',
    '.apply-button',
  ].filter(Boolean);

  const NEXT_BTN_SELECTORS = [
    'button:has-text("Next")',
    'button:has-text("Continue")',
    'button:has-text("Save & Next")',
    'button:has-text("Save and Next")',
    '[class*="next-btn"]:not([disabled])',
    '[class*="nextbtn"]:not([disabled])',
  ];

  const SUBMIT_SELECTORS = [
    selector.submitButton,
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    'button[type="submit"]',
    '[class*="submit-btn"]',
  ].filter(Boolean);

  const SUCCESS_SELECTORS = [
    selector.successIndicator,
    '.success-msg',
    '.applied-text',
    '[class*="applied"]',
    '[class*="success"]',
    '[class*="thank"]',
    'text=Application submitted',
    'text=Applied successfully',
    'text=already applied',
  ].filter(Boolean);

  const ALREADY_APPLIED_SELECTORS = [
    '.already-applied',
    '[class*="alreadyApplied"]',
    'button:has-text("Applied")',
    'text=Already Applied',
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        logger.info(`Retry ${attempt}/${maxRetries} for ${jobId}`);
        await backoff(attempt);
        // Re-navigate to job page on retry
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        await randomDelay(2000, 3000);
      }

      // ── 1. Already applied? ────────────────────────────────────────────
      for (const sel of ALREADY_APPLIED_SELECTORS) {
        if (await page.locator(sel).count() > 0) {
          logger.info(`Already applied: ${jobId}`);
          return { status: 'already_applied', unmatched };
        }
      }

      // ── 2. Find & click the Apply button ──────────────────────────────
      let applyClicked = false;
      for (const sel of APPLY_BTN_SELECTORS) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.count() > 0 && await btn.isVisible()) {
            await btn.click();
            applyClicked = true;
            logger.info(`Clicked apply: "${sel}"`);
            break;
          }
        } catch (_) {}
      }

      if (!applyClicked) {
        logger.warn(`No apply button found for ${jobId}`);
        if (attempt >= maxRetries) return { status: 'failed', unmatched };
        continue;
      }

      await randomDelay(1000, 2000);

      // ── 3. Check for new tab (external) ───────────────────────────────
      const pages = page.context().pages();
      if (pages.length > 1) {
        const newTab = pages[pages.length - 1];
        const extUrl = newTab.url();
        if (!extUrl.includes('naukri.com') && extUrl !== 'about:blank') {
          logger.info(`External tab opened: ${extUrl} – attempting to apply`);
          await captureScreenshot(newTab, jobId, 'external_opened');
          await randomDelay(1500, 2500); // let page fully load

          const extResult = await applyExternal(newTab, config);
          await captureScreenshot(newTab, jobId, extResult.status === 'success' ? 'submitted' : 'error');
          await newTab.close().catch(() => {});
          return { status: extResult.status, unmatched };
        }
      }

      // ── 4. Already applied check (post-click) ─────────────────────────
      for (const sel of ALREADY_APPLIED_SELECTORS) {
        if (await page.locator(sel).count() > 0) {
          logger.info(`Already applied (post-click): ${jobId}`);
          return { status: 'already_applied', unmatched };
        }
      }

      // ── 5. CAPTCHA / OTP pause ────────────────────────────────────────
      const captcha = await page.locator('[id*="captcha"], [class*="captcha"], [id*="otp"]').count();
      if (captcha > 0) {
        logger.warn('CAPTCHA/OTP detected – waiting 30s for manual input…');
        await page.waitForTimeout(30000);
      }

      // ── 6. Multi-step form handling (up to 8 steps) ───────────────────
      await captureScreenshot(page, jobId, 'opened');

      for (let step = 0; step < 8; step++) {
        logger.info(`Form step ${step + 1} for ${jobId}`);

        // Fill all visible fields on this step
        const stepUnmatched = await fillFormSmart(page, config);
        if (stepUnmatched.length) unmatched.push(...stepUnmatched);

        await randomDelay(600, 1200);
        await captureScreenshot(page, jobId, `form_step_${step + 1}`);

        // Check if a success state appeared mid-step
        let successFound = false;
        for (const sel of SUCCESS_SELECTORS) {
          try {
            if (await page.locator(sel).count() > 0) {
              successFound = true; break;
            }
          } catch (_) {}
        }
        if (successFound) {
          logger.info(`Success detected at step ${step + 1}`);
          await captureScreenshot(page, jobId, 'submitted');
          return { status: 'success', unmatched };
        }

        // Try Submit first
        let submittedOrAdvanced = false;
        for (const sel of SUBMIT_SELECTORS) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
              await btn.click();
              await randomDelay(1000, 2000);
              submittedOrAdvanced = true;
              logger.info(`Clicked submit: "${sel}"`);

              // Re-check success after submit
              for (const sSel of SUCCESS_SELECTORS) {
                try {
                  if (await page.locator(sSel).count() > 0) {
                    await captureScreenshot(page, jobId, 'submitted');
                    return { status: 'success', unmatched };
                  }
                } catch (_) {}
              }
              break;
            }
          } catch (_) {}
        }

        // If no submit found, try Next/Continue
        if (!submittedOrAdvanced) {
          let nextClicked = false;
          for (const sel of NEXT_BTN_SELECTORS) {
            try {
              const btn = page.locator(sel).first();
              if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
                await btn.click();
                await randomDelay(800, 1500);
                nextClicked = true;
                logger.info(`Clicked next: "${sel}"`);
                break;
              }
            } catch (_) {}
          }

          if (!nextClicked) {
            // No next or submit — form may be done or stuck
            logger.warn(`No next/submit button on step ${step + 1} – breaking`);
            break;
          }
        }
      }

      // ── 7. Final success check ────────────────────────────────────────
      await captureScreenshot(page, jobId, 'submitted');
      for (const sel of SUCCESS_SELECTORS) {
        try {
          if (await page.locator(sel).count() > 0) {
            return { status: 'success', unmatched };
          }
        } catch (_) {}
      }

      // If URL changed away from apply page, treat as success
      if (!page.url().includes('/apply') && !page.url().includes('applyjo')) {
        return { status: 'success', unmatched };
      }

      logger.warn(`No success indicator after all steps (attempt ${attempt})`);

    } catch (err) {
      logger.error(`Apply attempt ${attempt} error`, { jobId, err: err.message });
      await captureScreenshot(page, jobId, 'error').catch(() => {});
      if (attempt >= maxRetries) {
        return { status: 'failed', unmatched };
      }
    }
  }

  return { status: 'failed', unmatched };
}

// ── Main Worker ────────────────────────────────────────────────────────────

async function runWorker(config) {
  const {
    headless = false,
    slowMo = 20,
    delayMin = 1500,
    delayMax = 3000,
    maxAppsPerRun = 20,
    safetyMode = false,
    scoreThreshold = 50,
    selector = {},
    searchKeywords = [],
    searchLocation = '',
    jobsUrl,
  } = config;

  // Build the list of search URLs:
  // If searchKeywords are configured, use the search form flow.
  // Otherwise fall back to the hardcoded jobsUrl.
  const searchEntries = searchKeywords.length
    ? searchKeywords.map(kw => ({ keyword: kw, url: null }))  // urls resolved at runtime
    : [{ keyword: null, url: jobsUrl }];

  if (!searchKeywords.length && !jobsUrl) {
    logger.error('Either searchKeywords or jobsUrl is required in config/config.json');
    return;
  }

  logger.info('=== AutoApply Worker Starting ===');
  emitEvent('worker:start', { config: { jobsUrl, maxAppsPerRun } });

  const { browser, context } = await launchBrowser({ headless, slowMo, useAuth: true });
  const page = await context.newPage();

  let appliedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let externalCount = 0;
  let scannedCount = 0;

  const allUnmatched = [];
  const appliedJobLinks = [];
  const externalJobLinks = [];

  try {
    for (const entry of searchEntries) {
      if (appliedCount >= maxAppsPerRun) break;

      // ── Resolve search URL ─────────────────────────────────────────────
      let currentJobsUrl = entry.url;
      if (entry.keyword) {
        logger.info(`\n=== Searching for: "${entry.keyword}" in "${searchLocation || 'All India'}" ===`);
        try {
          currentJobsUrl = await performNaukriSearch(page, entry.keyword, searchLocation);
        } catch (err) {
          logger.warn(`[Search] Search flow failed for "${entry.keyword}": ${err.message}`);
          // Fallback URL
          const slug = entry.keyword.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          const locSlug = searchLocation ? '-in-' + searchLocation.toLowerCase() : '';
          currentJobsUrl = `https://www.naukri.com/${slug}-jobs${locSlug}`;
          await page.goto(currentJobsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
      } else {
        await page.goto(currentJobsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 4000);
        logger.info(`Navigated: ${currentJobsUrl}`);
      }

      // ── Scrape & apply from this search result page ───────────────────
      let pageNum = 1;

      outerLoop: while (appliedCount < maxAppsPerRun) {
        logger.info(`Scraping page ${pageNum} [${entry.keyword || currentJobsUrl}]...`);
        await randomDelay(800, 1500);

        // Scroll to load all cards
        for (let i = 0; i < 3; i++) {
          await randomScroll(page, 400);
          await randomDelay(600, 1200);
        }

        const cardSel = selector.jobCard || '.srp-jobtuple-wrapper';
        await page.waitForSelector(cardSel, { timeout: 15000 }).catch(() => {});
        const cards = page.locator(cardSel);
        const count = await cards.count();
        logger.info(`Found ${count} cards on page ${pageNum}`);

        if (count === 0) {
          logger.warn('No job cards found – check selector.jobCard in config.json');
          break;
        }

        for (let i = 0; i < count; i++) {
          if (appliedCount >= maxAppsPerRun) {
            logger.info(`Reached maxAppsPerRun (${maxAppsPerRun})`);
            break outerLoop;
          }

          const card = cards.nth(i);
          scannedCount++;

          let title = 'Unknown';
          let company = 'Unknown';
          let cardUrl = '';

          try {
            title   = ((await card.locator(selector.jobTitle   || '.title').first().textContent({ timeout: 3000 })) || '').trim();
            company = ((await card.locator(selector.companyName|| '.comp-name').first().textContent({ timeout: 3000 })) || '').trim();
            cardUrl = await card.locator('a').first().getAttribute('href') || '';
          } catch (_) {}

          const jobId = makeJobId(title, company);
          logger.info(`[${scannedCount}] "${title}" @ ${company}`);

          // Skip already-applied
          const existing = db.getJob(jobId);
          if (existing?.apply_status === 'success') {
            logger.info(`Already applied – skipping: ${jobId}`);
            skippedCount++;
            continue;
          }

          db.upsertJob({
            job_id: jobId, title, company, location: '', url: cardUrl || currentJobsUrl,
            description: '', decision: 'PENDING', score: 0,
            reason: 'pending analysis', apply_status: 'pending',
          });

          emitEvent('job:scanned', { jobId, title, company, scannedCount });

          // Open job in new tab
          let jobPage = page;
          let openedNewTab = false;
          try {
            const [newPage] = await Promise.all([
              context.waitForEvent('page', { timeout: 5000 }).catch(() => null),
              card.locator('a').first().click(),
            ]);
            if (newPage) {
              jobPage = newPage;
              openedNewTab = true;
              await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 });
            } else {
              await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
            }
          } catch (_) {
            logger.warn(`Could not open job detail: ${jobId}`);
          }

          await randomDelay(1500, 3000);

          const jobText = await jobPage.evaluate(() => document.body.innerText).catch(() => '');
          const jobUrl = jobPage.url();

          db.upsertJob({
            job_id: jobId, title, company, location: '', url: jobUrl,
            description: jobText.substring(0, 5000), decision: 'PENDING',
            score: 0, reason: '', apply_status: 'pending',
          });

          // AI decision
          const aiResult = await analyzeJob(jobText, config);
          logger.info(`AI: ${aiResult.decision} (${aiResult.score}) – ${aiResult.reason}`);

          db.upsertJob({
            job_id: jobId, title, company, location: '', url: jobUrl,
            description: jobText.substring(0, 5000),
            decision: aiResult.decision, score: aiResult.score, reason: aiResult.reason,
            apply_status: aiResult.decision === 'SKIP' ? 'skipped' : 'pending',
          });

          emitEvent('job:analyzed', { jobId, title, company, ...aiResult });

          if (aiResult.decision === 'APPLY' && aiResult.score >= scoreThreshold) {
            const safetyExtra = safetyMode ? delayMax * 1.5 : 0;
            await randomDelay(delayMin + safetyExtra, delayMax + safetyExtra);

            logger.info(`Applying: "${title}" @ ${company}`);
            emitEvent('job:applying', { jobId, title, company });

            const { status: applyResult, unmatched } = await applyToJob(jobPage, jobId, config);
            const appliedAt = new Date().toISOString();

            if (unmatched?.length) {
              allUnmatched.push(...unmatched.map(u => ({ ...u, job: title })));
            }

            if (applyResult === 'success' || applyResult === 'already_applied') {
              appliedCount++;
              appliedJobLinks.push({ title, company, url: jobUrl });
              db.updateJobApplyStatus(jobId, 'success', null, appliedAt);
              logger.info(`✅ Applied [${appliedCount}]: ${title}`);
              emitEvent('job:applied', { jobId, title, company, appliedCount });
            } else if (applyResult === 'external') {
              externalCount++;
              externalJobLinks.push({ title, company, url: jobUrl });
              db.updateJobApplyStatus(jobId, 'skipped', 'external site redirect', appliedAt);
              logger.warn(`↗ External site – skipped: ${title}`);
              emitEvent('job:skipped', { jobId, title, company, score: aiResult.score, reason: 'external site' });
            } else {
              errorCount++;
              db.updateJobApplyStatus(jobId, 'failed', 'Apply failed after retries', appliedAt);
              logger.error(`❌ Failed: ${title}`);
              emitEvent('job:failed', { jobId, title, company });
            }
          } else {
            skippedCount++;
            db.updateJobApplyStatus(jobId, 'skipped', `AI score ${aiResult.score} below threshold`);
            logger.info(`Skipped: "${title}" (score: ${aiResult.score})`);
            emitEvent('job:skipped', { jobId, title, company, score: aiResult.score });
          }

          // Close new tab
          if (openedNewTab && jobPage !== page) {
            await jobPage.close().catch(() => {});
          } else if (!openedNewTab && !page.url().includes('naukri.com/jobs')) {
            await page.goBack({ timeout: 10000 }).catch(() => page.goto(currentJobsUrl));
          }

          // Brief pause between jobs – anti-detection
          await randomDelay(delayMin, delayMax);
        } // end for cards

        // Next page
        const nextSel = selector.nextPage || '.next-btn, a[class*="next"]';
        const nextExists = await page.locator(nextSel).count();
        if (nextExists) {
          logger.info(`Going to page ${pageNum + 1}`);
          await humanClick(page, nextSel);
          await randomDelay(2000, 4000);
          pageNum++;
        } else {
          logger.info('No next page – all pages scanned');
          break;
        }
      } // end outerLoop while
    } // end for searchEntries

  } catch (err) {
    logger.error('Worker fatal error', { message: err.message, stack: err.stack });
    emitEvent('worker:error', { message: err.message });
  } finally {
    await closeBrowser(browser, context);

    // ── Final Summary ──────────────────────────────────────────────────
    const summary = {
      scannedCount,
      appliedCount,
      skippedCount,
      externalCount,
      errorCount,
      appliedJobLinks,
      externalJobLinks,
      unmatchedQuestions: allUnmatched,
    };

    logger.info('=== Session Summary ===');
    logger.info(`  Total scanned : ${scannedCount}`);
    logger.info(`  Applied       : ${appliedCount}`);
    logger.info(`  Skipped (AI)  : ${skippedCount}`);
    logger.info(`  External sites: ${externalCount}`);
    logger.info(`  Errors        : ${errorCount}`);
    if (appliedJobLinks.length) {
      logger.info('  Applied jobs:');
      appliedJobLinks.forEach(j => logger.info(`    ✅ ${j.title} @ ${j.company} – ${j.url}`));
    }
    if (externalJobLinks.length) {
      logger.info('  External (skipped):');
      externalJobLinks.forEach(j => logger.info(`    ↗ ${j.title} @ ${j.company} – ${j.url}`));
    }
    if (allUnmatched.length) {
      logger.warn('  Unanswered questions:');
      allUnmatched.forEach(u => logger.warn(`    ❓ [${u.job}] "${u.label}" (${u.type})`));
    }

    emitEvent('worker:done', summary);
  }
}

module.exports = { runWorker, setEmitter };
