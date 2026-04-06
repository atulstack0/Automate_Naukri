'use strict';

/**
 * src/portals/indeedWorker.js
 *
 * Indeed.com worker — mixes native apply with external redirects.
 * Export: runIndeed({ browser, config, db, io, ai })
 */

const { analyzeJob } = require('../ai/ollamaClient');
const CoverLetterGenerator = require('../ai/coverLetter');
const { launchBrowser }    = require('../browser/browser');
const db_singleton         = require('../db/db');
const logger               = require('../utils/logger');
const {
  humanDelay,
  randomDelay,
  randomScroll,
  safeClick,
  safeType,
} = require('../utils/antiDetection');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeJobId(jobDataJk, title, company) {
  const base = jobDataJk || `${title}_${company}`;
  return `IND_${base}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// applyIndeed — native vs external branching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect the apply button type and handle accordingly.
 *
 * @param {import('playwright').Page} page
 * @param {{ title, company, url, jobId }} job
 * @param {object} config
 * @param {string} coverLetter
 * @param {object} dbInstance  - Database instance (needs addToQueue)
 * @returns {Promise<{ success: boolean, type: string, reason?: string }>}
 */
async function applyIndeed(page, job, config, coverLetter, dbInstance) {
  const profile = config.profile || {};

  // Navigate to job page
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await humanDelay(1200, 2000);

  // ── Detect native Indeed apply button ────────────────────────────────────
  const NATIVE_SELECTORS = [
    '.icl-Button--primary',
    '#indeedApplyButton',
    'button[id*="indeed"]',
    'button:has-text("Apply now")',
    'button:has-text("Apply on Indeed")',
  ];

  // ── Detect external / company-site button ────────────────────────────────
  const EXTERNAL_SELECTORS = [
    'a[target="_blank"][href*="http"]',
    'a:has-text("company site")',
    'a:has-text("Company Site")',
    'a.icl-Button--primary[href*="http"]',
  ];

  let nativeBtn = null;
  for (const sel of NATIVE_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        nativeBtn = btn;
        logger.info(`[Indeed] Native apply button found: "${sel}"`);
        break;
      }
    } catch (_) {}
  }

  // ── INDEED NATIVE APPLY ──────────────────────────────────────────────────
  if (nativeBtn) {
    await nativeBtn.scrollIntoViewIfNeeded().catch(() => {});
    await nativeBtn.click({ timeout: 8000 });
    await humanDelay(2000, 2500);

    // If redirected away from indeed.com → treat as external
    const currentUrl = page.url();
    if (!currentUrl.includes('indeed.com')) {
      logger.info(`[Indeed] Redirect to external: ${currentUrl.substring(0, 80)}`);
      if (typeof dbInstance.addToQueue === 'function') {
        dbInstance.addToQueue({
          url:     currentUrl,
          title:   job.title,
          company: job.company,
          portal:  'Indeed',
          atsType: 'unknown',
        });
        logger.info('[Indeed] Queued external URL');
      }
      return { success: false, type: 'external', reason: 'queued for company worker' };
    }

    // ── Fill native Indeed form ────────────────────────────────────────────
    await safeType(page, 'input[name="applicant.name"]',        profile.name    || '');
    await safeType(page, 'input[name="applicant.email"]',       profile.email   || '');
    await safeType(page, 'input[name="applicant.phoneNumber"]', profile.phone   || '');

    // Cover letter
    await safeType(page,
      'textarea[name*="cover"], textarea[id*="cover"], textarea[aria-label*="cover" i]',
      coverLetter || profile.coverLetter || ''
    );

    // Resume upload
    try {
      const fileInput = await page.$('input[type="file"][name*="resume"], input[type="file"]');
      if (fileInput && config.resumePath) {
        await fileInput.setInputFiles(config.resumePath);
        logger.info('[Indeed] Resume uploaded');
      }
    } catch (e) {
      logger.warn(`[Indeed] Resume upload failed: ${e.message}`);
    }

    // Submit
    await safeClick(page, 'button[type="submit"]');
    await humanDelay(1500, 2500);

    logger.info(`[Indeed] ✅ Applied natively: ${job.title} @ ${job.company}`);
    return { success: true, type: 'indeed-native' };
  }

  // ── EXTERNAL APPLY ────────────────────────────────────────────────────────
  let externalUrl = '';
  for (const sel of EXTERNAL_SELECTORS) {
    try {
      const link = page.locator(sel).first();
      if (await link.count() > 0 && await link.isVisible()) {
        externalUrl = await link.getAttribute('href') || page.url();
        logger.info(`[Indeed] External link found: ${externalUrl.substring(0, 80)}`);
        break;
      }
    } catch (_) {}
  }

  const queueUrl = externalUrl || page.url();
  if (typeof dbInstance.addToQueue === 'function') {
    dbInstance.addToQueue({
      url:     queueUrl,
      title:   job.title,
      company: job.company,
      portal:  'Indeed',
      atsType: 'unknown',
    });
    logger.info(`[Indeed] Queued external URL: ${queueUrl.substring(0, 80)}`);
  }

  return { success: false, type: 'external', reason: 'queued for company worker' };
}

// ─────────────────────────────────────────────────────────────────────────────
// runIndeed — main portal runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ browser, config, db, io, ai }} opts
 */
async function runIndeed({ browser, config, db: dbArg, io, ai } = {}) {

  logger.info('[Indeed] Starting');
  if (io) io.emit('portal', { portal: 'Indeed', status: 'started' });

  const dbInstance = dbArg || db_singleton;
  const coverGen   = new CoverLetterGenerator(config);
  let appliedCount = 0;

  // Open page
  let page;
  try {
    if (browser && typeof browser.newPage === 'function') {
      page = await browser.newPage();
    } else {
      const { context } = await launchBrowser({ headless: config.headless });
      page = await context.newPage();
    }
  } catch (err) {
    logger.error('[Indeed] Could not open page', { err: err.message });
    if (io) io.emit('portal', { portal: 'Indeed', status: 'error', error: err.message });
    return;
  }

  try {
    // ── STEP 1: NAVIGATE + IMMEDIATE CAPTCHA CHECK ────────────────────────────
    const targetUrl = config.indeedUrl || 'https://in.indeed.com/jobs?q=QA+Engineer';
    logger.info(`[Indeed] Navigating: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(1000, 1800);

    // CAPTCHA check — must be immediate after navigation
    const captchaCount = await page.locator(
      '#indeed-captcha-modal, [data-testid="captcha"], iframe[src*="captcha"], .captcha-container'
    ).count();

    if (captchaCount > 0) {
      logger.warn('[Indeed] CAPTCHA detected on landing page!');
      if (io) io.emit('error', {
        portal: 'Indeed',
        message: 'CAPTCHA detected — run `npm run save-auth` again to refresh cookies',
      });
      return; // early exit
    }

    await randomScroll(page);
    await humanDelay(800, 1500);

    // ── STEP 2: SCRAPE CARDS ──────────────────────────────────────────────────
    await page.waitForSelector(
      '[data-jk], .job_seen_beacon, .resultContent',
      { timeout: 15000 }
    ).catch(() => {});

    const cards = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll(
        '[data-jk], .job_seen_beacon, .resultContent'
      )).slice(0, 30);

      return els.map(card => {
        const jk        = card.dataset?.jk || card.getAttribute('data-jk') || '';
        const titleEl   = card.querySelector('[data-testid="jobTitle"] span, .jobTitle span, [class*="jobTitle"] span');
        const compEl    = card.querySelector('[data-testid="company-name"], .companyName, [class*="companyName"]');
        const locEl     = card.querySelector('[data-testid="text-location"], .companyLocation');
        const linkEl    = card.querySelector('a[id^="job_"], a[href*="/rc/clk"], a[href*="viewjob"]');
        const href      = linkEl?.href || '';
        const fullUrl   = href.startsWith('http')
          ? href
          : 'https://www.indeed.com' + href;

        return {
          jobId:   jk,
          title:   titleEl?.textContent?.trim()  || 'Unknown',
          company: compEl?.textContent?.trim()   || 'Unknown',
          location:locEl?.textContent?.trim()    || '',
          url:     fullUrl,
        };
      }).filter(j => j.url && j.url !== 'https://www.indeed.com');
    });

    logger.info(`[Indeed] Scraped ${cards.length} cards`);
    if (io) io.emit('scraped', { portal: 'Indeed', count: cards.length });

    // ── STEP 3 + 4 + 5: PROCESS EACH JOB ────────────────────────────────────
    for (const job of cards) {
      if (appliedCount >= (config.maxAppsPerRun || 15)) break;

      const jobId = makeJobId(job.jobId, job.title, job.company);

      // Dedup
      const alreadyApplied = typeof dbInstance.isAlreadyApplied === 'function'
        ? dbInstance.isAlreadyApplied(job.jobId || jobId, 'Indeed')
        : false;

      if (alreadyApplied) {
        logger.info(`[Indeed] Already applied — skip: ${job.title}`);
        continue;
      }

      // ── STEP 3: GET DESCRIPTION ─────────────────────────────────────────
      let description = '';
      try {
        // Click the card to load the right-pane description (SRP mode)
        const cardSel = `[data-jk="${job.jobId}"], a[href*="${job.jobId}"]`;
        const cardEl  = page.locator(cardSel).first();

        if (await cardEl.count() > 0) {
          await cardEl.click().catch(() => {});
          await page.waitForSelector('#jobDescriptionText, .jobsearch-jobDescriptionText', {
            timeout: 8000,
          }).catch(() => {});
          await humanDelay(600, 1000);

          description = await page.locator(
            '#jobDescriptionText, .jobsearch-jobDescriptionText'
          ).first().innerText().catch(() => '') || '';
        }

        // Fallback: navigate directly to job URL and scrape
        if (!description && job.url) {
          await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await humanDelay(800, 1400);
          description = await page.locator(
            '#jobDescriptionText, .jobsearch-jobDescriptionText'
          ).first().innerText().catch(() => '')
            || await page.evaluate(() => document.body.innerText.slice(0, 3000));
        }
      } catch (descErr) {
        logger.debug(`[Indeed] Description error for ${job.title}: ${descErr.message}`);
      }

      // ── STEP 4: AI SCORING ─────────────────────────────────────────────
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
          const r = await analyzeJob(description, config);
          score = r.score; decision = r.decision; reason = r.reason;
        }
      } catch (aiErr) {
        logger.warn(`[Indeed] AI score failed: ${aiErr.message}`);
      }

      logger.info(`[Indeed] "${job.title}": ${decision} (${score}) — ${reason}`);
      if (io) io.emit('job_scored', { portal: 'Indeed', job, score, decision });

      if (decision === 'SKIP' || score < (config.scoreThreshold || 60)) {
        try {
          dbInstance.saveApplication?.({
            jobId: job.jobId || jobId, portal: 'Indeed',
            title: job.title, company: job.company, location: job.location,
            score, status: 'skipped', aiReason: reason, applyUrl: job.url,
          });
        } catch (_) {}
        continue;
      }

      // ── STEP 5: APPLY ──────────────────────────────────────────────────
      try {
        const coverLetter = await coverGen.generate({ job, profile: config.profile });
        const result = await applyIndeed(page, job, config, coverLetter, dbInstance);

        const status = result.success ? 'applied' : (result.type === 'external' ? 'skipped' : 'failed');

        logger.info(`[Indeed] Apply result for "${job.title}": ${result.type} success=${result.success}`);

        try {
          dbInstance.saveApplication?.({
            jobId: job.jobId || jobId, portal: 'Indeed',
            title: job.title, company: job.company, location: job.location,
            score, status, aiReason: reason,
            coverLetter: result.success ? coverLetter : undefined,
            applyUrl: job.url,
          });
        } catch (_) {}

        if (result.success) {
          if (io) io.emit('applied', { portal: 'Indeed', job, score, status: 'applied' });
          appliedCount++;
        } else {
          if (io) io.emit('job_scored', {
            portal: 'Indeed', job, score,
            decision: result.type === 'external' ? 'QUEUED' : 'FAILED',
            reason: result.reason,
          });
        }

      } catch (applyErr) {
        logger.error(`[Indeed] Apply error for "${job.title}": ${applyErr.message}`);
        if (io) io.emit('error', { portal: 'Indeed', job, error: applyErr.message });
      }

      // Back to results page before next card
      try {
        if (!page.url().includes('indeed.com/jobs') && !page.url().includes('in.indeed.com/jobs')) {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await humanDelay(1500, 2500);
        } else {
          await page.goBack({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() =>
            page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
          );
        }
      } catch (_) {}

      await humanDelay(config.delayMin || 2000, config.delayMax || 5000);
    }

  } finally {
    if (io) io.emit('portal', { portal: 'Indeed', status: 'done', applied: appliedCount });
    logger.info(`[Indeed] Done — applied to ${appliedCount} job(s)`);
    await page.close().catch(() => {});
  }
}

module.exports = { runIndeed, applyIndeed };
