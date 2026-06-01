'use strict';

/**
 * src/portals/naukriWorker.js
 *
 * Naukri.com Worker — search → AI score → apply.
 * Export: runNaukri({ browser, config, db, io, ai })
 */

const path = require('path');
const fs   = require('fs');

const { launchBrowser, closeBrowser } = require('../browser/browser');
const { analyzeJob }                  = require('../ai/ollamaClient');
const CoverLetterGenerator            = require('../ai/coverLetter');
const db_singleton                    = require('../db/db');
const logger                          = require('../utils/logger');
const { handleLoginRequired }         = require('../auth/autoLogin');
const {
  randomDelay,
  randomScroll,
  humanDelay,
  highlightAndClick,
} = require('../utils/antiDetection');

const {
  applyToJob:  engineApply,
  detectAnomalies,
  handleAnomaly,
  screenshot:  engineScreenshot,
} = require('../worker/applyEngine');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJobId(title, company) {
  return `${title}_${company}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 80) + '_' + Date.now();
}

// ─── Naukri Search Flow ───────────────────────────────────────────────────────

/**
 * performNaukriSearch()
 *
 * Flow:
 *   1. Go to naukri.com
 *   2. Expand header search bar if collapsed
 *   3. Clear & type keyword
 *   4. Clear & type location, pick first suggestion
 *   5. Click Search button
 *   6. Wait for results page and return its URL
 */
async function performNaukriSearch(page, keyword, location = '') {
  logger.info(`\n[Search] ── Searching: "${keyword}" in "${location || 'All India'}" ──`);

  await page.goto('https://www.naukri.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await randomDelay(1800, 2800);
  logger.info('[Search] Naukri homepage loaded');

  // Expand header search bar
  try {
    const searchIcon = page.locator('div.nI-gNb-sb__icon-wrapper, [class*="nI-gNb-sb__icon"]').first();
    if (await searchIcon.count() > 0 && await searchIcon.isVisible()) {
      await highlightAndClick(page, searchIcon, 'Open Search Bar');
      await randomDelay(600, 1000);
    }
  } catch (_) {}

  // Keyword input
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
        await el.fill('');
        await el.type(keyword, { delay: 55 });
        logger.info(`[Search] ✏️  Typed keyword: "${keyword}"`);
        await randomDelay(700, 1100);
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
    return url;
  }

  // Location input
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
          await randomDelay(800, 1200);

          const SUGGESTION_SELECTORS = [
            '.suggestor-drop li', '.suggestor-wrapper li',
            '[class*="suggestor"] li', '[class*="dropdown"] li',
            '[class*="suggestion"] li', 'ul.dropdown li',
          ];
          let pickedSuggestion = false;
          for (const sug of SUGGESTION_SELECTORS) {
            try {
              const first = page.locator(sug).first();
              if (await first.count() > 0 && await first.isVisible()) {
                await highlightAndClick(page, first, `📍 ${location}`);
                pickedSuggestion = true;
                break;
              }
            } catch (_) {}
          }
          if (!pickedSuggestion) await page.keyboard.press('Enter').catch(() => {});
          break;
        }
      } catch (_) {}
    }
  }

  await randomDelay(400, 700);

  // Search button
  const SEARCH_BTN_SELECTORS = [
    'button.nI-gNb-sb__icon-wrapper',
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
    logger.warn('[Search] Search button not found – pressing Enter');
    await page.keyboard.press('Enter');
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
  await randomDelay(1500, 2500);

  const resultUrl = page.url();
  logger.info(`[Search] 📋 Results URL: ${resultUrl}`);
  return resultUrl;
}

// ─── runNaukri — main portal runner ──────────────────────────────────────────

/**
 * Run the Naukri portal: login check → search → scrape → AI score → apply.
 *
 * @param {{ browser, config, db, io, ai }} opts
 */
async function runNaukri({ browser, config, db: dbArg, io, ai } = {}) {
  logger.info('[Naukri] Starting');
  if (io) io.emit('portal', { portal: 'Naukri', status: 'started' });

  const dbInstance = dbArg || db_singleton;
  const coverGen   = new CoverLetterGenerator(config);
  let appliedCount = 0;

  // ── Open page ────────────────────────────────────────────────────────────────
  let page, context, _browser;
  try {
    if (browser && typeof browser.newPage === 'function') {
      page = await browser.newPage();
    } else if (browser && browser.context && typeof browser.context.newPage === 'function') {
      page = await browser.context.newPage();
      context = browser.context;
    } else {
      const session = await launchBrowser({ headless: config.headless, slowMo: config.slowMo, useAuth: true });
      _browser = session.browser;
      context  = session.context;
      page     = await context.newPage();
    }
  } catch (err) {
    logger.error('[Naukri] Failed to open page', { err: err.message });
    if (io) io.emit('portal', { portal: 'Naukri', status: 'error', error: err.message });
    return;
  }

  // ── Login check ──────────────────────────────────────────────────────────────
  logger.info('[Naukri] Verifying login status...');
  await page.goto('https://www.naukri.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(2000, 3000);

  const isLoggedIn = await page.evaluate(() =>
    !!document.querySelector('.nI-gNb-drawer__icon') || !!document.querySelector('.user-name')
  );

  if (!isLoggedIn) {
    logger.warn('[Naukri] User logged out — initiating auto-login...');
    if (_browser) await closeBrowser(_browser, context);

    const loginSuccess = await handleLoginRequired('naukri');
    if (!loginSuccess) {
      logger.error('[Naukri] Auto-login failed. Aborting.');
      if (io) io.emit('worker:error', { message: 'Naukri auto-login failed' });
      return;
    }

    const newSession = await launchBrowser({ headless: config.headless, slowMo: config.slowMo, useAuth: true });
    _browser = newSession.browser;
    context  = newSession.context;
    page     = await context.newPage();
  } else {
    logger.info('[Naukri] Login verified. Proceeding...');
  }

  // ── Build search entries ─────────────────────────────────────────────────────
  const searchEntries = config.searchKeywords?.length
    ? config.searchKeywords.map(kw => ({ keyword: kw, url: null }))
    : [{ keyword: null, url: config.jobsUrl || 'https://www.naukri.com/' }];

  try {
    for (const entry of searchEntries) {
      if (appliedCount >= (config.maxAppsPerRun || 15)) {
        logger.info('[Naukri] Reached max apps per run limit.');
        break;
      }

      // ── Navigate / Search ──────────────────────────────────────────────────
      let currentJobsUrl = entry.url;
      if (entry.keyword) {
        logger.info(`\n=== [Naukri] Searching: "${entry.keyword}" in "${config.searchLocation || 'All India'}" ===`);
        try {
          currentJobsUrl = await performNaukriSearch(page, entry.keyword, config.searchLocation);
        } catch (err) {
          logger.warn(`[Naukri] Search failed for "${entry.keyword}": ${err.message}`);
          const slug    = entry.keyword.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          const locSlug = config.searchLocation ? '-in-' + config.searchLocation.toLowerCase().replace(/\s+/g, '-') : '';
          currentJobsUrl = `https://www.naukri.com/${slug}-jobs${locSlug}`;
          await page.goto(currentJobsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
      } else {
        await page.goto(currentJobsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 4000);
      }

      // ── Scrape cards ───────────────────────────────────────────────────────
      await page.waitForSelector('.jobTuple, .srp-jobtuple-wrapper', { timeout: 15000 }).catch(() => {});
      await randomScroll(page);

      const jobs = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll(
          '.srp-jobtuple-wrapper, .jobTuple, [data-job-id]'
        )).slice(0, 30);

        return cards.map(card => {
          const href  = card.querySelector('a.title, a[title], .title a, a')?.href || '';
          const urlId = (href.match(/-(\d{10,})[^\d]?$/) || [])[1] || '';
          return {
            jobId:    card.getAttribute('data-job-id')
                      || card.querySelector('[data-job-id]')?.getAttribute('data-job-id')
                      || urlId || '',
            title:    card.querySelector('.title, [class*="title"]')?.textContent?.trim()      || 'Unknown',
            company:  card.querySelector('.comp-name, [class*="comp-name"]')?.textContent?.trim() || 'Unknown',
            location: card.querySelector('.location, [class*="location"]')?.textContent?.trim()   || '',
            salary:   card.querySelector('.salary, [class*="salary"]')?.textContent?.trim()        || '',
            applyUrl: href || '',
          };
        });
      });

      logger.info(`[Naukri] Scraped ${jobs.length} cards for keyword "${entry.keyword}"`);
      if (io) io.emit('scraped', { portal: 'Naukri', count: jobs.length });

      // ── Process each job ───────────────────────────────────────────────────
      for (const job of jobs) {
        if (appliedCount >= (config.maxAppsPerRun || 15)) break;

        // Stable dedup ID
        const urlJobId = job.applyUrl
          ? (job.applyUrl.match(/-(\d{8,})[^\d]*$/) || [])[1] || ''
          : '';
        const stableId = job.jobId || urlJobId || makeJobId(job.title, job.company);
        job.jobId = stableId;

        // Skip if already applied
        let alreadyApplied = false;
        try {
          const appRow = dbInstance._db
            .prepare('SELECT status FROM applications WHERE job_id = ? AND portal = ?')
            .get(stableId, 'Naukri');
          alreadyApplied = !!appRow && (appRow.status === 'applied' || appRow.status === 'success');
        } catch (_) {
          if (typeof dbInstance.getJob === 'function') {
            const existing = dbInstance.getJob(stableId);
            alreadyApplied = existing?.apply_status === 'success';
          }
        }

        if (alreadyApplied) {
          logger.info(`[Naukri] Already applied — skipping: ${job.title}`);
          continue;
        }

        // Fetch description
        let description = '';
        let jobPage = null;
        if (job.applyUrl) {
          try {
            jobPage = await page.context().newPage();
            await jobPage.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await randomDelay(800, 1500);
            description = await jobPage.evaluate(() =>
              document.querySelector('.job-desc, .jd-desc, [class*="job-desc"]')?.innerText
              || document.body.innerText.slice(0, 3000)
            ).catch(() => '');
          } catch (err) {
            logger.debug(`[Naukri] Could not load job detail for ${job.title}: ${err.message}`);
            if (jobPage) { await jobPage.close().catch(() => {}); jobPage = null; }
          }
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
              title: job.title, company: job.company, location: job.location,
              description, keywords, profile: config.profile || {},
            }));
          } else {
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

        const skipThreshold = config.scoreThreshold || 40;
        if (decision === 'SKIP' || score < skipThreshold) {
          logger.info(`[Naukri] Skipping "${job.title}" — ${reason} (score ${score}, threshold ${skipThreshold})`);
          try {
            dbInstance.saveApplication?.({
              jobId: stableId, portal: 'naukri',
              title: job.title, company: job.company, location: job.location,
              score, status: 'skipped', aiReason: reason, applyUrl: job.applyUrl,
            });
          } catch (_) {}
          if (jobPage) { await jobPage.close().catch(() => {}); jobPage = null; }
          continue;
        }

        // Apply
        if (!job.applyUrl) {
          if (jobPage) { await jobPage.close().catch(() => {}); jobPage = null; }
          continue;
        }
        
        try {
          if (!jobPage) {
            jobPage = await page.context().newPage();
            await jobPage.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await randomDelay(1000, 1800);
          } else {
            await randomDelay(500, 1000);
          }

          const applyJob = { jobId: stableId, title: job.title, company: job.company, url: job.applyUrl };
          const result   = await engineApply(jobPage, applyJob, config, {
            maxRetries: config.maxRetries || 2,
            portal:     'naukri',
            db:         dbInstance,
            io,
          });

          const status    = result.status === 'success' || result.status === 'already_applied'
            ? 'applied' : result.status;
          const appliedAt = new Date().toISOString();

          try {
            dbInstance.saveApplication?.({
              jobId: stableId, portal: 'naukri',
              title: job.title, company: job.company, location: job.location,
              score, status, aiReason: reason,
              applyUrl: job.applyUrl,
            });
          } catch (_) {}

          if (status === 'applied') {
            appliedCount++;
            logger.info(`[Naukri] ✅ Applied [${appliedCount}]: ${job.title}`);
            if (io) io.emit('applied', { portal: 'Naukri', job, score, status: 'applied' });
          } else {
            logger.warn(`[Naukri] ⚠️  Apply result for "${job.title}": ${result.status}`);
            if (io) io.emit('error', { portal: 'Naukri', job, error: result.reason });
          }

        } catch (applyErr) {
          logger.error(`[Naukri] Apply error for "${job.title}": ${applyErr.message}`);
          if (io) io.emit('error', { portal: 'Naukri', job, error: applyErr.message });
        } finally {
          if (jobPage) { await jobPage.close().catch(() => {}); jobPage = null; }
        }

        await humanDelay(config.delayMin || 2000, config.delayMax || 4000);
      } // end for jobs
    } // end for searchEntries

  } finally {
    if (_browser) await closeBrowser(_browser, context).catch(() => {});
    if (io) io.emit('portal', { portal: 'Naukri', status: 'done', applied: appliedCount });
    logger.info(`[Naukri] Done — applied to ${appliedCount} job(s)`);
    await page.close().catch(() => {});
  }
}

module.exports = { runNaukri, performNaukriSearch };
