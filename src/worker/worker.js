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
const { handleLoginRequired } = require('../auth/autoLogin');
const {
  randomDelay,
  humanClick,
  randomScroll,
  readingPause,
  backoff,
  highlightAndClick,
} = require('../utils/antiDetection');

// ── Apply Engine (comprehensive edge-case handler) ─────────────────────────
const {
  applyToJob:    engineApply,
  detectAnomalies,
  handleAnomaly,
  screenshot:    engineScreenshot,
} = require('./applyEngine');


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
 * applyToJob — delegates to the comprehensive applyEngine.
 * All edge-case handling (CAPTCHA, OTP, external tab, multi-step modals,
 * validation errors, learning list, etc.) lives in applyEngine.js.
 *
 * @param {import('playwright').Page} page
 * @param {string} jobId
 * @param {object} config
 * @returns {Promise<{ status: string, unmatched: Array }>}
 */
async function applyToJob(page, jobId, config) {
  const job = { jobId, title: config._jobTitle || 'Job', company: config._jobCompany || 'Company' };

  const result = await engineApply(page, job, config, {
    maxRetries: config.maxRetries || 2,
    portal:     'naukri',
    db:         config.db || null,
    io:         config.io || null,
  });

  // normalise legacy shape
  return {
    status:    result.status,
    unmatched: result.unmatched || [],
  };
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

  let { browser, context } = await launchBrowser({ headless, slowMo, useAuth: true });
  let page = await context.newPage();

  // ── Auto-Login Check ───────────────────────────────────────────────────
  logger.info(`[Worker] Verifying Naukri login status...`);
  await page.goto('https://www.naukri.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(2000, 3000);

  // Check if logged in (presence of user avatar/drawer)
  const isLoggedIn = await page.evaluate(() => {
    return !!document.querySelector('.nI-gNb-drawer__icon') || !!document.querySelector('.user-name');
  });

  if (!isLoggedIn) {
    logger.warn(`[Worker] User is logged out of Naukri. Initiating auto-login protocol...`);
    // Close headless browser temporarily
    await closeBrowser(browser, context);
    
    // Prompt user for login visually
    const loginSuccess = await handleLoginRequired('naukri');
    if (!loginSuccess) {
      logger.error(`[Worker] Auto-login failed or timed out. Aborting run.`);
      emitEvent('worker:error', { message: 'Naukri auto-login failed' });
      return;
    }

    // Re-launch headless browser with NEW merged auth.json
    logger.info(`[Worker] Re-launching headless browser with updated credentials...`);
    const newSession = await launchBrowser({ headless, slowMo, useAuth: true });
    browser = newSession.browser;
    context = newSession.context;
    page = await context.newPage();
  } else {
    logger.info(`[Worker] Login verified. Proceeding...`);
  }

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
            logger.info(`[Worker] Reached maxAppsPerRun limit (${maxAppsPerRun})`);
            break outerLoop;
          }

          const card = cards.nth(i);
          scannedCount++;
          logger.info(`\n[Worker] Processing Job ${i + 1}/${count} (Total Scanned: ${scannedCount})`);

          let title = 'Unknown';
          let company = 'Unknown';
          let location = 'Unknown';
          let cardUrl = '';
          try {
            title    = ((await card.locator(selector.jobTitle   || '.title').first().textContent({ timeout: 3000 })) || '').trim();
            company  = ((await card.locator(selector.companyName|| '.comp-name').first().textContent({ timeout: 3000 })) || '').trim();
            location = ((await card.locator(selector.jobLocation || '.location').first().textContent({ timeout: 3000 })) || '').trim();
            cardUrl = await card.locator('a').first().getAttribute('href') || '';
            // Resolve relative URLs (e.g. '/job-listings/...') to absolute Naukri URLs
            if (cardUrl && !cardUrl.startsWith('http')) {
              try { cardUrl = new URL(cardUrl, 'https://www.naukri.com').href; } catch (_) {}
            }
            logger.info(`[Worker] Scraped Job: "${title.trim()}" at "${company.trim()}" (${location.trim()})`);
          } catch (e) {
            logger.debug('[Worker] Partial scrape failed for card', { err: e.message });
          }

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
            // Store cardUrl if available; the second upsert (after job tab opens) will
            // always overwrite with the actual job detail page URL via jobPage.url()
            job_id: jobId, title, company, location, url: cardUrl || '',
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

          await randomDelay(400, 800);  // minimal settle — removed wasteful long delay

          const jobText = await jobPage.evaluate(() => document.body.innerText).catch(() => '');
          const jobUrl = jobPage.url();
          logger.info(`[Worker] Job page URL: ${jobUrl} (job_id: ${jobId})`);

          db.upsertJob({
            job_id: jobId, title, company, location, url: jobUrl,
            description: jobText.substring(0, 5000), decision: 'PENDING',
            score: 0, reason: '', apply_status: 'pending',
          });

          // AI decision
          const aiResult = await analyzeJob(jobText, config);
          logger.info(`AI: ${aiResult.decision} (${aiResult.score}) – ${aiResult.reason}`);

          db.upsertJob({
            job_id: jobId, title, company, location, url: jobUrl,
            description: jobText.substring(0, 5000),
            decision: aiResult.decision, score: aiResult.score, reason: aiResult.reason,
            apply_status: aiResult.decision === 'SKIP' ? 'skipped' : 'pending',
          });

          emitEvent('job:analyzed', { jobId, title, company, ...aiResult });

          if (aiResult.decision === 'APPLY' && aiResult.score >= scoreThreshold) {
            // Minimal human-like pause — no need for full delayMin/delayMax before clicking Apply
            const safetyExtra = safetyMode ? 1000 : 0;
            await randomDelay(300 + safetyExtra, 600 + safetyExtra);

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

// ═══════════════════════════════════════════════════════════════════════════
// runNaukri — Spec API adapter
// Implements the requested signature: runNaukri({ browser, config, db, io, ai })
//
// Bridges the new clean API into the existing battle-tested runWorker logic
// without duplicating code. Falls back to internal singletons when optional
// args are not provided (backward compat with index.js calls).
// ═══════════════════════════════════════════════════════════════════════════

const CoverLetterGenerator = require('../ai/coverLetter');
const { safeClick, safeType, humanDelay } = require('../utils/antiDetection');

/**
 * Run the Naukri portal: scrape → AI score → apply.
 *
 * @param {{ browser: BrowserManager, config: object, db: Database, io: SocketIO, ai: OllamaClient }} opts
 */
async function runNaukri({ browser, config, db: dbArg, io, ai } = {}) {
  // ── STEP 1: INIT ─────────────────────────────────────────────────────────
  logger.info('[Naukri] Starting');
  if (io) io.emit('portal', { portal: 'Naukri', status: 'started' });

  // Resolve db — use passed db or fall back to singleton
  const dbInstance = dbArg || db;

  // Wire socket.io emitter into existing emitEvent system
  if (io) setEmitter((event, data) => io.emit(event, data));

  const coverGen = new CoverLetterGenerator(config);
  let appliedCount = 0;

  // Open page — support both BrowserManager class and legacy context object
  let page;
  try {
    if (browser && typeof browser.newPage === 'function') {
      page = await browser.newPage();
    } else if (browser && browser.context && typeof browser.context.newPage === 'function') {
      page = await browser.context.newPage();
    } else {
      // No browser provided — launch internally (legacy mode)
      const { context } = await launchBrowser({ headless: config.headless, slowMo: config.slowMo });
      page = await context.newPage();
    }
  } catch (err) {
    logger.error('[Naukri] Failed to open page', { err: err.message });
    if (io) io.emit('portal', { portal: 'Naukri', status: 'error', error: err.message });
    return;
  }

  try {
    const searchEntries = config.searchKeywords?.length
      ? config.searchKeywords.map(kw => ({ keyword: kw, url: null }))
      : [{ keyword: null, url: config.jobsUrl || 'https://www.naukri.com/' }];

    for (const entry of searchEntries) {
      if (appliedCount >= (config.maxAppsPerRun || 15)) {
        logger.info(`[Naukri] Reached max apps per run limit.`);
        break;
      }

      // ── STEP 2: NAVIGATE & SEARCH ─────────────────────────────────────────
      let currentJobsUrl = entry.url;
      if (entry.keyword) {
        logger.info(`\n=== [Naukri] Searching for: "${entry.keyword}" in "${config.searchLocation || 'All India'}" ===`);
        try {
          currentJobsUrl = await performNaukriSearch(page, entry.keyword, config.searchLocation);
        } catch (err) {
          logger.warn(`[Naukri] Search flow failed for "${entry.keyword}": ${err.message}`);
          const slug = entry.keyword.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          const locSlug = config.searchLocation ? '-in-' + config.searchLocation.toLowerCase().replace(/\s+/g, '-') : '';
          currentJobsUrl = `https://www.naukri.com/${slug}-jobs${locSlug}`;
          await page.goto(currentJobsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
      } else {
        await page.goto(currentJobsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 4000);
      }

      await page.waitForSelector('.jobTuple, .srp-jobtuple-wrapper', { timeout: 15000 }).catch(() => {});
      await randomScroll(page);

      // ── STEP 3: SCRAPE CARDS ───────────────────────────────────────────────
      const jobs = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll(
          '.srp-jobtuple-wrapper, .jobTuple, [data-job-id]'
        )).slice(0, 30);

        return cards.map(card => {
          const href = card.querySelector('a.title, a[title], .title a, a')?.href || '';
          // Naukri URLs end with a 12-digit numeric job ID, e.g. "-300126502321"
          const urlId = (href.match(/-(\d{10,})[^\d]?$/) || [])[1] || '';
          return {
            jobId:    card.getAttribute('data-job-id')
                      || card.querySelector('[data-job-id]')?.getAttribute('data-job-id')
                      || urlId
                      || '',
            title:    card.querySelector('.title, [class*="title"]')?.textContent?.trim()   || 'Unknown',
            company:  card.querySelector('.comp-name, [class*="comp-name"]')?.textContent?.trim() || 'Unknown',
            location: card.querySelector('.location, [class*="location"]')?.textContent?.trim()   || '',
            salary:   card.querySelector('.salary, [class*="salary"]')?.textContent?.trim()       || '',
            applyUrl: href || '',
          };
        });
      });

      logger.info(`[Naukri] Scraped ${jobs.length} cards for keyword "${entry.keyword}"`);
      if (io) io.emit('scraped', { portal: 'Naukri', count: jobs.length });

      // ── STEP 4 + 5: PROCESS EACH JOB ──────────────────────────────────────
      for (const job of jobs) {
      if (appliedCount >= (config.maxAppsPerRun || 15)) break;

      // ── Dedup: extract a stable unique key from URL if card has no data-job-id ──
      // Naukri URLs end with a long numeric ID, e.g. "-300126502321"
      // Fall back to title+company hash ONLY when no ID can be extracted from URL.
      const urlJobId = job.applyUrl
        ? (job.applyUrl.match(/-(\d{8,})[^\d]*$/) || [])[1] || ''
        : '';
      const stableId = job.jobId || urlJobId || makeJobId(job.title, job.company);
      job.jobId = stableId; // enrich for downstream use

      // Only skip if previously APPLIED (not just scored/skipped)
      let alreadyApplied = false;
      if (typeof dbInstance.isAlreadyApplied === 'function') {
        // Check both applications table (status='applied') and legacy jobs table
        const appRow = dbInstance._db
          .prepare('SELECT status FROM applications WHERE job_id = ? AND portal = ?')
          .get(stableId, 'Naukri');
        alreadyApplied = !!appRow && (appRow.status === 'applied' || appRow.status === 'success');
      } else if (typeof dbInstance.getJob === 'function') {
        const existing = dbInstance.getJob(stableId);
        alreadyApplied = existing?.apply_status === 'success';
      }

      if (alreadyApplied) {
        logger.info(`[Naukri] Already applied — skipping: ${job.title}`);
        continue;
      }

      // Navigate to job detail to get description
      let description = '';
      if (job.applyUrl) {
        try {
          const jobPage = await page.context().newPage();
          await jobPage.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await randomDelay(800, 1500);
          description = await jobPage.evaluate(() => {
            return document.querySelector('.job-desc, .jd-desc, [class*="job-desc"]')?.innerText
              || document.body.innerText.slice(0, 3000);
          }).catch(() => '');
          await jobPage.close().catch(() => {});
        } catch (err) {
          logger.debug(`[Naukri] Could not load job detail for ${job.title}: ${err.message}`);
        }
      }

      // AI scoring — use passed ai client or internal analyzeJob
      let score = 0, decision = 'SKIP', reason = 'no AI';
      try {
        const keywords = [
          ...(config.keywords?.required  || []),
          ...(config.keywords?.preferred || []),
        ];

        if (ai && typeof ai.scoreJob === 'function') {
          // New OllamaClient class
          ({ score, decision, reason } = await ai.scoreJob({
            title: job.title, company: job.company, location: job.location,
            description, keywords, profile: config.profile || {},
          }));
        } else {
          // Legacy analyzeJob fallback
          const result = await analyzeJob(description || `${job.title} ${job.company}`, config);
          score    = result.score;
          decision = result.decision;
          reason   = result.reason;
        }
      } catch (err) {
        logger.warn(`[Naukri] AI scoring failed for ${job.title}: ${err.message}`);
      }

      logger.info(`[Naukri] Scored "${job.title}": ${decision} (${score}) — ${reason}`);
      if (io) io.emit('job_scored', { portal: 'Naukri', job, score, decision });

      // ── SKIP gate ──────────────────────────────────────────────────────────
      // Trust the scorer's decision. Only use scoreThreshold as a secondary
      // guard when AI is ON (Ollama) — never let threshold override APPLY in
      // keyword-only mode because keyword scores are inherently low (8–15pt/hit).
      const aiIsOff = !(config.aiEnabled !== false) || config.skipAI;
      const skipThreshold = aiIsOff ? 0 : (config.scoreThreshold || 60);

      if (decision === 'SKIP' || score < skipThreshold) {
        logger.info(`[Naukri] Skipping "${job.title}" — ${reason} (score ${score}, threshold ${skipThreshold})`);
        // Save as skipped
        try {
          if (typeof dbInstance.saveApplication === 'function') {
            dbInstance.saveApplication({
              jobId: job.jobId || makeJobId(job.title, job.company),
              portal: 'Naukri', title: job.title, company: job.company,
              location: job.location, salary: job.salary,
              score, status: 'skipped', aiReason: reason,
              applyUrl: job.applyUrl,
            });
          } else {
            dbInstance.upsertJob({
              job_id: makeJobId(job.title, job.company), title: job.title,
              company: job.company, location: job.location, url: job.applyUrl,
              description: '', decision: 'SKIP', score, reason, apply_status: 'skipped',
            });
          }
        } catch (e) { logger.debug(`[Naukri] DB save-skipped error: ${e.message}`); }
        continue;
      }


      // ── STEP 5: APPLY ──────────────────────────────────────────────────
      try {
        const coverLetter = await coverGen.generate({ job, profile: config.profile }).catch(() => '');

        // Navigate to job detail page first
        await page.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await randomDelay(1000, 2000);

        // Delegate to comprehensive apply engine
        // Pass job metadata & cover letter so engine can log and fill correctly
        const applyResult = await engineApply(page, {
          jobId:   job.jobId || makeJobId(job.title, job.company),
          title:   job.title,
          company: job.company,
          url:     job.applyUrl,
          portal:  'naukri',
        }, {
          ...config,
          coverLetter,
          db:    dbInstance,
          io,
        }, {
          maxRetries: 2,
          portal:     'naukri',
          db:         dbInstance,
          io,
        });

        const applyStatus = applyResult.status; // 'success'|'failed'|'already_applied'|'external'

        const screenshotFile = screenshotPath(job.jobId || job.title, applyStatus);

        // Save to DB
        const statusForDb = applyStatus === 'success' ? 'applied'
                          : applyStatus === 'already_applied' ? 'already_applied'
                          : 'failed';

        if (typeof dbInstance.saveApplication === 'function') {
          dbInstance.saveApplication({
            jobId:    job.jobId || makeJobId(job.title, job.company),
            portal:   'Naukri', title: job.title, company: job.company,
            location: job.location, salary: job.salary, score,
            status:   statusForDb, aiReason: reason, coverLetter,
            screenshot: screenshotFile, applyUrl: job.applyUrl,
          });
        }

        // Update legacy jobs table
        try {
          dbInstance.upsertJob?.({
            job_id: makeJobId(job.title, job.company), title: job.title,
            company: job.company, location: job.location, url: job.applyUrl,
            description: '', decision: 'APPLY', score, reason,
            apply_status: statusForDb === 'applied' ? 'success' : statusForDb,
          });
        } catch (_) {}

        if (applyStatus === 'success') {
          logger.info(`[Naukri] ✅ Applied [${appliedCount + 1}]: ${job.title} @ ${job.company} (${applyResult.steps} steps)`);
          if (io) io.emit('applied', { portal: 'Naukri', job, score, status: 'applied' });
          appliedCount++;
        } else if (applyStatus === 'already_applied') {
          logger.info(`[Naukri] ⏭ Already applied: ${job.title} @ ${job.company}`);
        } else {
          logger.warn(`[Naukri] ❌ Apply ${applyStatus}: ${job.title} — ${applyResult.reason}`);
          if (io) io.emit('error', { portal: 'Naukri', job, error: applyResult.reason });
        }

      } catch (applyErr) {
        logger.error(`[Naukri] Apply threw: ${applyErr.message}`, { stack: applyErr.stack?.split('\n')[1] });

        try {
          if (typeof dbInstance.saveApplication === 'function') {
            dbInstance.saveApplication({
              jobId:    job.jobId || makeJobId(job.title, job.company),
              portal:   'Naukri', title: job.title, company: job.company,
              location: job.location, salary: job.salary, score,
              status: 'failed', aiReason: applyErr.message, applyUrl: job.applyUrl,
            });
          }
        } catch (e) { logger.debug(`[Naukri] DB save-failed error: ${e.message}`); }

        if (io) io.emit('error', { portal: 'Naukri', job, error: applyErr.message });
      }


      // Human-like delay between jobs
      await humanDelay(config.delayMin || 2000, config.delayMax || 5000);
      } // end inner for
    } // end outer for

  } finally {
    // ── STEP 6: DONE ──────────────────────────────────────────────────────
    if (io) io.emit('portal', { portal: 'Naukri', status: 'done', applied: appliedCount });
    logger.info(`[Naukri] Done — applied to ${appliedCount} job(s)`);
    await page.close().catch(() => {});
  }
}

// Re-export with runNaukri added
module.exports = { runWorker, setEmitter, runNaukri };

