'use strict';

/**
 * src/portals/linkedinWorker.js
 *
 * LinkedIn Easy Apply Worker — search → AI score → apply.
 * Export: runLinkedin({ browser, config, db, io, ai })
 */

const path = require('path');
const fs   = require('fs');

const { launchBrowser, closeBrowser } = require('../browser/browser');
const { analyzeJob }                  = require('../ai/ollamaClient');
const { fillFormSmart }               = require('../worker/formFiller');
const db_singleton                    = require('../db/db');
const logger                          = require('../utils/logger');
const { handleLoginRequired }         = require('../auth/autoLogin');
const {
  randomDelay,
  randomScroll,
  humanDelay,
  highlightAndClick,
  backoff,
} = require('../utils/antiDetection');

// ─── Filter param maps ────────────────────────────────────────────────────────

const EXPERIENCE_MAP = {
  internship: '1', entry: '2', 'entry-level': '2',
  associate: '3', mid: '4', 'mid-senior': '4', 'mid-level': '4', senior: '4',
  director: '5', executive: '6',
};

const JOB_TYPE_MAP = {
  'full-time': 'F', fulltime: 'F',
  'part-time': 'P', parttime: 'P',
  contract: 'C', temporary: 'T', temp: 'T',
  internship: 'I', volunteer: 'V', other: 'O',
};

const DATE_MAP = {
  day: 'r86400', '24h': 'r86400',
  week: 'r604800', '7d': 'r604800',
  month: 'r2592000', '30d': 'r2592000',
};

const REMOTE_MAP = {
  'on-site': '1', onsite: '1',
  remote: '2', 'work-from-home': '2', wfh: '2',
  hybrid: '3',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJobId(title, company) {
  return `LI_${title}_${company}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 100)
    .toLowerCase();
}

async function captureScreenshot(page, db, jobId, stage) {
  try {
    const date = new Date().toISOString().split('T')[0];
    const dir  = path.join(process.cwd(), 'data', 'screenshots', date);
    fs.mkdirSync(dir, { recursive: true });

    const ts     = new Date().toISOString().replace(/[:T]/g, '-').replace(/\.\d+Z$/, '');
    const filePath = path.join(dir, `${jobId}_${stage}_${ts}.png`);

    await page.screenshot({ path: filePath, fullPage: false });
    db.saveScreenshot?.(jobId, stage, filePath);
    return filePath;
  } catch (_) {
    return null;
  }
}

/**
 * Build LinkedIn filter query params from the linkedinFilters config object.
 * Supported keys:
 *   experienceLevel: string | string[]  — "mid-senior", "entry", etc.
 *   jobType:         string | string[]  — "full-time", "contract", etc.
 *   datePosted:      string             — "day", "week", "month"
 *   remote:          string | string[]  — "remote", "hybrid", "on-site"
 */
function buildFilterParams(filters = {}) {
  const params = {};

  if (filters.experienceLevel) {
    const levels = [].concat(filters.experienceLevel)
      .map(l => EXPERIENCE_MAP[l.toLowerCase()])
      .filter(Boolean);
    if (levels.length) params.f_E = levels.join(',');
  }

  if (filters.jobType) {
    const types = [].concat(filters.jobType)
      .map(t => JOB_TYPE_MAP[t.toLowerCase()])
      .filter(Boolean);
    if (types.length) params.f_JT = types.join(',');
  }

  if (filters.datePosted) {
    const tpr = DATE_MAP[filters.datePosted.toLowerCase()];
    if (tpr) params.f_TPR = tpr;
  }

  if (filters.remote) {
    const remotes = [].concat(filters.remote)
      .map(r => REMOTE_MAP[r.toLowerCase()])
      .filter(Boolean);
    if (remotes.length) params.f_WT = remotes.join(',');
  }

  return params;
}

// ─── LinkedIn Search ──────────────────────────────────────────────────────────

async function performLinkedinSearch(page, keyword, location = '', filters = {}) {
  logger.info(`\n[LinkedIn] ── Searching: "${keyword}" in "${location || 'All Locations'}" ──`);

  const encodedKeyword  = encodeURIComponent(keyword);
  const encodedLocation = encodeURIComponent(location);

  // Always enable Easy Apply filter; layer in any additional filters
  const filterParams = buildFilterParams(filters);
  const qs = new URLSearchParams({
    f_AL: 'true',
    keywords: keyword,
    location,
    ...filterParams,
  }).toString();

  const searchUrl = `https://www.linkedin.com/jobs/search/?${qs}`;
  logger.info(`[LinkedIn] Search URL: ${searchUrl}`);

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(2500, 4000);

  const isLoggedOut = await page.locator('.btn-secondary-emphasis:has-text("Sign in")').count() > 0;
  if (isLoggedOut) {
    logger.warn('[LinkedIn] Bot appears to be logged out. Automation may fail.');
  }

  const noResults = await page.locator(
    '.jobs-search-two-pane__no-results-banner, :has-text("No matching jobs found")'
  ).count() > 0;
  if (noResults) {
    logger.warn(`[LinkedIn] No results found for "${keyword}" in "${location}"`);
    return null;
  }

  logger.info('[LinkedIn] Search page loaded');
  return searchUrl;
}

// ─── External site application ────────────────────────────────────────────────

/**
 * Click external Apply button, handle the popup/new-tab, fill the form, submit.
 * Returns { status: 'external_applied' | 'external_failed', unmatched: [] }
 */
async function handleExternalApplication(page, config, db, jobId) {
  const unmatched = [];

  // Find the plain Apply button (not Easy Apply)
  const externalBtn = page.locator(
    'button:has-text("Apply"):not(:has-text("Easy Apply")), a:has-text("Apply Now"), a:has-text("Apply")'
  ).first();

  if (await externalBtn.count() === 0 || !await externalBtn.isVisible()) {
    logger.warn('[LinkedIn] External Apply button not found');
    return { status: 'external_failed', unmatched };
  }

  logger.info('[LinkedIn] Clicking external Apply button and waiting for popup...');
  const context = page.context();

  let externalPage = null;
  try {
    [externalPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 8000 }),
      externalBtn.click({ timeout: 10000 }).catch(() => {}),
    ]);
  } catch (_) {
    // No popup opened — check if current page navigated
    externalPage = null;
  }

  // If no popup, check for URL change on current page
  if (!externalPage) {
    await randomDelay(2000, 3000);
    const currentUrl = page.url();
    if (!currentUrl.includes('linkedin.com')) {
      externalPage = page;
    } else {
      logger.warn('[LinkedIn] External apply did not open a new tab or navigate');
      return { status: 'external_failed', unmatched };
    }
  }

  try {
    await externalPage.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await randomDelay(1500, 2500);

    const externalUrl = externalPage.url();
    logger.info(`[LinkedIn] External site: ${externalUrl}`);

    await captureScreenshot(externalPage, db, jobId, 'external_form');

    const formUnmatched = await fillFormSmart(externalPage, config);
    if (formUnmatched.length) unmatched.push(...formUnmatched);

    await randomDelay(600, 1200);

    // Try to submit the external form
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Submit")',
      'button:has-text("Apply")',
      'button:has-text("Send Application")',
      'input[type="submit"]',
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      const btn = externalPage.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
        logger.info(`[LinkedIn] Submitting external form: "${sel}"`);
        await btn.click({ timeout: 10000 });
        await randomDelay(2000, 3500);
        submitted = true;
        break;
      }
    }

    await captureScreenshot(externalPage, db, jobId, 'external_submitted');

    // Close popup tab if it was a new tab (not the main page)
    if (externalPage !== page) {
      await externalPage.close().catch(() => {});
    }

    return { status: submitted ? 'external_applied' : 'external_failed', unmatched };
  } catch (err) {
    logger.error(`[LinkedIn] External form error: ${err.message}`);
    if (externalPage && externalPage !== page) {
      await externalPage.close().catch(() => {});
    }
    return { status: 'external_failed', unmatched };
  }
}

// ─── Apply to a single LinkedIn job ──────────────────────────────────────────

async function applyToLinkedinJob(page, jobId, config, db) {
  const { maxRetries = 3, profile = {} } = config;
  let unmatched = [];

  const EASY_APPLY_SELECTORS = [
    '.jobs-apply-button--top-card button.jobs-apply-button',
    'button.jobs-apply-button:has-text("Easy Apply")',
    'button:has-text("Easy Apply")',
    '[data-control-name="jobdetails_topcard_inapply"]',
    'button.jobs-apply-button',
  ];

  const NEXT_BTN_SELECTORS = [
    'button[aria-label="Continue to next step"]',
    'button:has-text("Next")',
    'button:has-text("Review")',
  ];

  const SUBMIT_SELECTORS = [
    'button[aria-label="Submit application"]',
    'button:has-text("Submit application")',
    'button:has-text("Submit")',
  ];

  const SUCCESS_SELECTORS = [
    'h3:has-text("Your application was sent")',
    '[class*="artdeco-modal__header"]:has-text("Application sent")',
    'button:has-text("Done")',
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        logger.info(`[LinkedIn] Retry ${attempt}/${maxRetries} for ${jobId}`);
        await backoff(attempt);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        await randomDelay(2000, 3000);
      }

      // Check already applied
      for (const sel of [
        '.artdeco-inline-feedback__message:has-text("Applied")',
        '.artdeco-inline-feedback--success:has-text("Applied")',
        'span.t-bold:has-text("Applied")',
      ]) {
        if (await page.locator(sel).count() > 0) {
          logger.info(`[LinkedIn] Already applied: ${jobId}`);
          return { status: 'already_applied', unmatched };
        }
      }

      // Wait briefly for the apply button area to settle
      await page.waitForSelector(
        EASY_APPLY_SELECTORS.join(', ') + ', button:has-text("Apply")',
        { state: 'visible', timeout: 8000 }
      ).catch(() => {});

      // Check if this is an Easy Apply job (look for enabled Easy Apply button)
      let easyApplyBtn = null;
      for (const sel of EASY_APPLY_SELECTORS) {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0 && await btn.isVisible()) {
          // Confirm it says "Easy Apply" in text or has the easy-apply class
          const text = (await btn.textContent().catch(() => '')).trim();
          const cls  = (await btn.getAttribute('class').catch(() => '')).trim();
          const isEasyApply = text.includes('Easy Apply') ||
            cls.includes('jobs-apply-button') ||
            sel.includes('Easy Apply') ||
            sel.includes('inapply');
          if (isEasyApply) {
            easyApplyBtn = btn;
            break;
          }
        }
      }

      if (easyApplyBtn) {
        // Check if enabled — disabled means already applied or not eligible
        const isEnabled = await easyApplyBtn.isEnabled().catch(() => true);
        if (!isEnabled) {
          logger.info(`[LinkedIn] Easy Apply button disabled (already applied?): ${jobId}`);
          return { status: 'already_applied', unmatched };
        }

        logger.info('[LinkedIn] Clicking Easy Apply button');
        await easyApplyBtn.scrollIntoViewIfNeeded().catch(() => {});
        await easyApplyBtn.click({ timeout: 10000 });
        await randomDelay(1500, 2500);
      } else {
        // No Easy Apply — check for external Apply button
        const externalApply = page.locator('button:has-text("Apply")').first();
        if (await externalApply.count() > 0 && await externalApply.isVisible()) {
          logger.info(`[LinkedIn] External Apply button found for ${jobId} — opening external form`);
          return await handleExternalApplication(page, config, db, jobId);
        }

        logger.warn(`[LinkedIn] No apply button found for ${jobId}`);
        if (attempt >= maxRetries) return { status: 'failed', unmatched };
        continue;
      }

      await captureScreenshot(page, db, jobId, 'opened_modal');

      const MODAL_SEL = '.jobs-easy-apply-modal';

      // Step through modal forms (up to 10 steps)
      for (let step = 0; step < 10; step++) {
        logger.info(`\n[LinkedIn] Job ${jobId}: Form Step ${step + 1}`);

        await page.waitForSelector(MODAL_SEL, { state: 'attached', timeout: 5000 }).catch(() => {});

        const stepUnmatched = await fillFormSmart(page, {
          ...config,
          scopeSelector: MODAL_SEL,
          blockResumeUpload: step > 0, // only upload resume on first step
        });
        if (stepUnmatched.length) unmatched.push(...stepUnmatched);

        await randomDelay(600, 1200);
        await captureScreenshot(page, db, jobId, `form_step_${step + 1}`);

        // Success check
        let successFound = false;
        for (const sel of SUCCESS_SELECTORS) {
          if (await page.locator(sel).count() > 0 && await page.locator(sel).first().isVisible()) {
            successFound = true;
            break;
          }
        }
        if (successFound) {
          logger.info(`[LinkedIn] Success at step ${step + 1}`);
          const doneBtn = page.locator('button:has-text("Done")').first();
          if (await doneBtn.count() > 0) await doneBtn.click().catch(() => {});
          await captureScreenshot(page, db, jobId, 'submitted');
          return { status: 'success', unmatched };
        }

        // Try Submit
        const modal = page.locator(MODAL_SEL).first();
        let submitted = false;
        for (const sel of SUBMIT_SELECTORS) {
          const btn = modal.locator(sel).first();
          if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
            await btn.click();
            await randomDelay(2000, 3000);
            submitted = true;
            logger.info(`[LinkedIn] Clicked Submit: "${sel}"`);
            break;
          }
        }

        if (submitted) {
          for (const sel of SUCCESS_SELECTORS) {
            if (await page.locator(sel).count() > 0) {
              const doneBtn = page.locator('button:has-text("Done")').first();
              if (await doneBtn.count() > 0) await doneBtn.click().catch(() => {});
              await captureScreenshot(page, db, jobId, 'submitted');
              return { status: 'success', unmatched };
            }
          }
          break;
        }

        // Try Next/Review
        let advanced = false;
        for (const sel of NEXT_BTN_SELECTORS) {
          const btn = modal.locator(sel).first();
          if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
            await btn.click();
            await randomDelay(1000, 2000);
            advanced = true;
            logger.info(`[LinkedIn] Clicked Next/Review: "${sel}"`);
            break;
          }
        }

        if (!advanced) {
          // Check for validation errors. Re-fill ONLY ONCE per step; do NOT
          // loop back to the top of the step — that causes infinite re-filling.
          const errorCount = await page.locator('.artdeco-inline-feedback--error').count();
          if (errorCount > 0) {
            logger.warn(`[LinkedIn] Validation errors on step ${step + 1} – doing a single targeted re-fill`);
            // Re-fill just once with error-awareness, then try Next again
            await fillFormSmart(page, {
              ...config,
              scopeSelector: MODAL_SEL,
              blockResumeUpload: true,  // don't re-upload resume on retry
            }).catch(() => {});
            await randomDelay(800, 1400);

            // Now try Next one more time after the correction
            for (const sel of NEXT_BTN_SELECTORS) {
              const btn = modal.locator(sel).first();
              if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
                await btn.click();
                await randomDelay(1000, 2000);
                advanced = true;
                logger.info(`[LinkedIn] Clicked Next/Review after re-fill: "${sel}"`);
                break;
              }
            }

            // If still not advanced, skip this step to avoid infinite loop
            if (!advanced) {
              logger.warn(`[LinkedIn] Still stuck on step ${step + 1} after re-fill – moving on`);
            }
            // Either way, do NOT `continue` — fall through to next step iteration
          } else {
            logger.warn(`[LinkedIn] No next/submit on step ${step + 1} – breaking`);
            break;
          }
        }
      }

    } catch (err) {
      logger.error(`[LinkedIn] Apply attempt ${attempt} error: ${err.message}`);
      await captureScreenshot(page, db, jobId, 'error').catch(() => {});
      if (attempt >= maxRetries) return { status: 'failed', unmatched };
    }
  }

  return { status: 'failed', unmatched };
}

// ─── runLinkedin — main portal runner ────────────────────────────────────────

/**
 * Run the LinkedIn portal: login check → search → scrape → AI score → Easy Apply.
 *
 * @param {{ browser, config, db, io, ai }} opts
 */
async function runLinkedin({ browser, config, db: dbArg, io, ai } = {}) {
  logger.info('[LinkedIn] Starting');
  if (io) io.emit('portal', { portal: 'LinkedIn', status: 'started' });

  const dbInstance = dbArg || db_singleton;
  let appliedCount  = 0;
  let skippedCount  = 0;
  let errorCount    = 0;
  let externalCount = 0;
  let scannedCount  = 0;

  const {
    headless        = false,
    slowMo          = 20,
    delayMin        = 1500,
    delayMax        = 3000,
    maxAppsPerRun   = 20,
    safetyMode      = false,
    scoreThreshold  = 50,
    searchKeywords  = [],
    searchLocation  = '',
    linkedinUrl,
    linkedinFilters = {},
  } = config;

  // Build search entries
  const searchEntries = searchKeywords.length
    ? searchKeywords.map(kw => ({ keyword: kw, url: null }))
    : linkedinUrl
      ? [{ keyword: null, url: linkedinUrl }]
      : [];

  if (!searchEntries.length) {
    logger.error('[LinkedIn] No searchKeywords or linkedinUrl configured. Aborting.');
    if (io) io.emit('portal', { portal: 'LinkedIn', status: 'error', error: 'No search config' });
    return;
  }

  // ── Open page ───────────────────────────────────────────────────────────────
  let page, context, _browser;
  try {
    if (browser && typeof browser.newPage === 'function') {
      page = await browser.newPage();
    } else if (browser && browser.context && typeof browser.context.newPage === 'function') {
      page    = await browser.context.newPage();
      context = browser.context;
    } else {
      const session = await launchBrowser({ headless, slowMo, useAuth: true });
      _browser = session.browser;
      context  = session.context;
      page     = await context.newPage();
    }
  } catch (err) {
    logger.error('[LinkedIn] Failed to open page', { err: err.message });
    if (io) io.emit('portal', { portal: 'LinkedIn', status: 'error', error: err.message });
    return;
  }

  // ── Login check ─────────────────────────────────────────────────────────────
  logger.info('[LinkedIn] Verifying login status...');
  await page.goto('https://www.linkedin.com/feed', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(2000, 3000);

  const isLoggedIn = await page.evaluate(() =>
    !window.location.href.includes('linkedin.com/signup') &&
    !window.location.href.includes('linkedin.com/login') &&
    !document.querySelector('form.join-form') &&
    !document.querySelector('.authwall-join-form')
  );

  if (!isLoggedIn) {
    logger.warn('[LinkedIn] User is logged out — initiating auto-login...');
    if (_browser) await closeBrowser(_browser, context).catch(() => {});

    const loginSuccess = await handleLoginRequired('linkedin');
    if (!loginSuccess) {
      logger.error('[LinkedIn] Auto-login failed. Aborting.');
      if (io) io.emit('worker:error', { message: 'LinkedIn auto-login failed' });
      return;
    }

    const newSession = await launchBrowser({ headless, slowMo, useAuth: true });
    _browser = newSession.browser;
    context  = newSession.context;
    page     = await context.newPage();
  } else {
    logger.info('[LinkedIn] Login verified. Proceeding...');
  }

  try {
    for (const entry of searchEntries) {
      if (appliedCount >= maxAppsPerRun) break;

      let currentJobsUrl = entry.url;
      if (entry.keyword) {
        currentJobsUrl = await performLinkedinSearch(page, entry.keyword, searchLocation, linkedinFilters);
        if (!currentJobsUrl) continue;
      } else {
        await page.goto(currentJobsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 4000);
      }

      let pageNum = 1;

      outerLoop: while (appliedCount < maxAppsPerRun) {
        logger.info(`[LinkedIn] Scraping page ${pageNum}...`);

        // Scroll list pane to load cards
        const listSelector = '.jobs-search-results-list';
        await page.waitForSelector(listSelector, { timeout: 15000 }).catch(() => {});
        const jobList = page.locator(listSelector);
        if (await jobList.count() > 0) {
          for (let i = 0; i < 5; i++) {
            await jobList.evaluate(el => { el.scrollBy(0, 500); });
            await randomDelay(500, 1000);
          }
        }

        const cards = page.locator('.job-card-container');
        const count = await cards.count();
        logger.info(`[LinkedIn] Found ${count} cards on page ${pageNum}`);

        if (count === 0) {
          logger.warn('[LinkedIn] No job cards found — end of search or rate limited.');
          break;
        }

        for (let i = 0; i < count; i++) {
          if (appliedCount >= maxAppsPerRun) break outerLoop;

          const card = cards.nth(i);
          scannedCount++;

          let title    = 'Unknown';
          let company  = 'Unknown';
          let location = 'Unknown';
          let cardUrl  = '';

          try {
            await card.scrollIntoViewIfNeeded();

            const cleanDupe = (str) => {
              if (!str) return '';
              const s = str.trim();
              const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
              if (lines.length > 1 && lines[0] === lines[1]) return lines[0];
              const half = Math.floor(s.length / 2);
              if (s.length > 4 && s.substring(0, half) === s.substring(s.length - half)) return s.substring(0, half).trim();
              return s;
            };

            const titleLoc = card.locator('.job-card-list__title, .job-card-list__title--link, strong');
            if (await titleLoc.count() > 0) title = cleanDupe(await titleLoc.first().innerText());

            const compLoc = card.locator('.job-card-container__company-name, .artdeco-entity-lockup__subtitle');
            if (await compLoc.count() > 0) company = cleanDupe(await compLoc.first().innerText());

            const locNode = card.locator('.job-card-container__metadata-wrapper li');
            if (await locNode.count() > 0) location = (await locNode.first().innerText()).trim();

            cardUrl = await card.locator('a').first().getAttribute('href').catch(() => null) || currentJobsUrl;
            if (cardUrl && cardUrl.startsWith('/')) cardUrl = `https://www.linkedin.com${cardUrl}`;

            await highlightAndClick(page, card, `Select ${title.substring(0, 15)}`);
            await randomDelay(1500, 2500);
          } catch (e) {
            logger.debug('[LinkedIn] Card scrape error', { err: e.message });
          }

          const jobId = makeJobId(title, company);
          logger.info(`\n[LinkedIn] [${scannedCount}] "${title}" @ ${company}`);

          // Dedup check
          let alreadyApplied = false;
          try {
            const row = dbInstance._db
              .prepare('SELECT status FROM applications WHERE job_id = ? AND portal = ?')
              .get(jobId, 'LinkedIn');
            alreadyApplied = !!row && (row.status === 'applied' || row.status === 'success');
          } catch (_) {
            const existing = dbInstance.getJob?.(jobId);
            alreadyApplied = existing?.apply_status === 'success';
          }

          if (alreadyApplied) {
            logger.info(`[LinkedIn] Already applied — skip: ${jobId}`);
            skippedCount++;
            continue;
          }

          // Get job description from right pane
          const jobDetailsPane = page.locator('.jobs-search__job-details--container, .job-view-layout').first();
          let jobText = '';
          if (await jobDetailsPane.count() > 0) {
            const seeMore = jobDetailsPane.locator('button:has-text("See more")').first();
            if (await seeMore.count() > 0 && await seeMore.isVisible()) {
              await seeMore.click().catch(() => {});
            }
            jobText = await jobDetailsPane.innerText().catch(() => '');
          }

          // AI scoring
          let score = 0, decision = 'SKIP', reason = 'no AI';
          try {
            const keywords = [
              ...(config.keywords?.required  || []),
              ...(config.keywords?.preferred || []),
            ];
            if (ai && typeof ai.scoreJob === 'function') {
              ({ score, decision, reason } = await ai.scoreJob({
                title, company, location,
                description: jobText,
                keywords,
                profile: config.profile || {},
              }));
            } else {
              const r = await analyzeJob(jobText, config);
              score = r.score; decision = r.decision; reason = r.reason;
            }
          } catch (err) {
            logger.warn(`[LinkedIn] AI scoring failed for ${title}: ${err.message}`);
          }

          logger.info(`[LinkedIn] Scored "${title}": ${decision} (${score}) — ${reason}`);
          if (io) io.emit('job_scored', { portal: 'LinkedIn', job: { title, company, location, applyUrl: cardUrl }, score, decision });

          if (decision === 'SKIP' || score < scoreThreshold) {
            skippedCount++;
            try {
              dbInstance.saveApplication?.({
                jobId, portal: 'LinkedIn',
                title, company, location,
                score, status: 'skipped', aiReason: reason, applyUrl: cardUrl,
              });
            } catch (_) {}
            logger.info(`[LinkedIn] Skipped "${title}" (score ${score}, threshold ${scoreThreshold})`);
            if (io) io.emit('job_scored', { portal: 'LinkedIn', job: { title, company }, score, decision: 'SKIP', reason });
            await randomDelay(delayMin, delayMax);
            continue;
          }

          // Apply
          logger.info(`[LinkedIn] Applying: "${title}" @ ${company}`);
          if (io) io.emit('applying', { portal: 'LinkedIn', job: { title, company }, score });

          const safetyExtra = safetyMode ? 1000 : 0;
          await randomDelay(500 + safetyExtra, 1000 + safetyExtra);

          const { status: applyResult, unmatched } = await applyToLinkedinJob(page, jobId, config, dbInstance);
          const appliedAt = new Date().toISOString();

          const isSuccess  = applyResult === 'success' || applyResult === 'already_applied' || applyResult === 'external_applied';
          const isExternal = applyResult === 'external' || applyResult === 'external_failed';
          const dbStatus   = isSuccess ? 'applied' : isExternal ? 'skipped' : 'failed';

          try {
            dbInstance.saveApplication?.({
              jobId, portal: 'LinkedIn',
              title, company, location,
              score, status: dbStatus, aiReason: reason, applyUrl: cardUrl,
            });
          } catch (_) {}

          if (isSuccess) {
            appliedCount++;
            const tag = applyResult === 'external_applied' ? '↗ External' : '✅';
            logger.info(`[LinkedIn] ${tag} Applied [${appliedCount}]: ${title}`);
            if (io) io.emit('applied', { portal: 'LinkedIn', job: { title, company, applyUrl: cardUrl }, score, status: 'applied' });
          } else if (isExternal) {
            externalCount++;
            logger.warn(`[LinkedIn] ↗ External site – could not submit: ${title}`);
            if (io) io.emit('job_scored', { portal: 'LinkedIn', job: { title, company }, score, decision: 'EXTERNAL' });
          } else {
            errorCount++;
            logger.error(`[LinkedIn] ❌ Failed: ${title}`);
            if (io) io.emit('error', { portal: 'LinkedIn', job: { title, company }, error: `Apply failed after ${maxRetries} retries` });
          }

          await randomDelay(delayMin, delayMax);
        } // end for cards

        // Pagination
        const pagination = page.locator('.artdeco-pagination__pages, .jobs-search-results-list__pagination');
        if (await pagination.count() > 0) {
          let nextBtn = page.locator(`button[aria-label="Page ${pageNum + 1}"], [aria-label*="Page ${pageNum + 1}"]`).first();
          if (await nextBtn.count() === 0) {
            nextBtn = page.locator('.artdeco-pagination__button--next, button:has-text("Next")').first();
          }
          if (await nextBtn.count() > 0 && await nextBtn.isVisible() && await nextBtn.isEnabled()) {
            logger.info(`[LinkedIn] Going to page ${pageNum + 1}`);
            await nextBtn.scrollIntoViewIfNeeded();
            await nextBtn.click();
            await randomDelay(3000, 5000);
            pageNum++;
          } else {
            logger.info('[LinkedIn] No next page — scanning complete');
            break;
          }
        } else {
          break;
        }
      } // end outerLoop
    } // end for searchEntries

  } catch (err) {
    logger.error('[LinkedIn] Fatal error', { message: err.message, stack: err.stack });
    if (io) io.emit('worker:error', { message: err.message });
  } finally {
    if (_browser) await closeBrowser(_browser, context).catch(() => {});
    if (io) io.emit('portal', { portal: 'LinkedIn', status: 'done', applied: appliedCount });
    logger.info('[LinkedIn] === Session Summary ===');
    logger.info(`[LinkedIn]   Scanned  : ${scannedCount}`);
    logger.info(`[LinkedIn]   Applied  : ${appliedCount}`);
    logger.info(`[LinkedIn]   Skipped  : ${skippedCount}`);
    logger.info(`[LinkedIn]   External : ${externalCount}`);
    logger.info(`[LinkedIn]   Errors   : ${errorCount}`);
    await page.close().catch(() => {});
  }
}

module.exports = { runLinkedin };
