'use strict';

/**
 * src/portals/companyWorker.js
 *
 * Company Website Worker — the most advanced AutoApply module.
 * Uses Ollama AI + FormFiller to dynamically apply on any careers page.
 * For known ATS types (Workday, Greenhouse, Lever, SmartRecruiters) it
 * delegates to externalApplier.applyExternal() which has the proper
 * multi-step click flow.
 *
 * Export: runCompany({ browser, config, db, io, ai })
 */

const path = require('path');
const fs   = require('fs');

const { analyzeJob }          = require('../ai/ollamaClient');
const CoverLetterGenerator    = require('../ai/coverLetter');
const { FormFiller }          = require('../utils/formFiller');
const { applyExternal }       = require('../worker/externalApplier');
const { launchBrowser }       = require('../browser/browser');
const db_singleton            = require('../db/db');
const logger                  = require('../utils/logger');
const {
  humanDelay, randomDelay, randomScroll,
} = require('../utils/antiDetection');

// ─────────────────────────────────────────────────────────────────────────────
// ATS detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect the ATS platform from a job URL.
 * @param {string} url
 * @returns {string} 'greenhouse'|'lever'|'workday'|'ashby'|'smartrecruiters'|'unknown'
 */
function detectATS(url = '') {
  const u = url.toLowerCase();
  if (u.includes('boards.greenhouse.io'))          return 'greenhouse';
  if (u.includes('jobs.lever.co'))                 return 'lever';
  if (u.includes('myworkdayjobs.com'))             return 'workday';
  if (u.includes('workday.com'))                   return 'workday';
  if (u.includes('jobs.ashbyhq.com'))              return 'ashby';
  if (u.includes('careers.smartrecruiters.com'))  return 'smartrecruiters';
  if (u.includes('smartrecruiters.com'))           return 'smartrecruiters';
  if (u.includes('icims.com'))                     return 'icims';
  if (u.includes('taleo.net'))                     return 'taleo';
  if (u.includes('successfactors.com'))            return 'successfactors';
  return 'unknown';
}

// ATS types handled by externalApplier (which has proper multi-step flow)
const EXTERNAL_APPLIER_ATS = new Set([
  'workday', 'greenhouse', 'lever', 'smartrecruiters', 'icims', 'taleo', 'successfactors',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Screenshot helper
// ─────────────────────────────────────────────────────────────────────────────

async function takeScreenshot(page, label) {
  try {
    const dir = path.join(process.cwd(), 'data', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const ts    = new Date().toISOString().replace(/[:T.]/g, '-').replace('Z', '');
    const file  = path.join(dir, `company_${label}_${ts}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch (e) {
    logger.debug(`[Company] Screenshot failed: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigate to page — uses domcontentloaded for SPA-heavy ATS sites like Workday
// ─────────────────────────────────────────────────────────────────────────────

async function navigateTo(page, url, atsType) {
  // Workday and other SPAs never reach networkidle — use domcontentloaded + extra wait
  const waitUntil = (atsType === 'workday' || atsType === 'successfactors' || atsType === 'taleo')
    ? 'domcontentloaded'
    : 'networkidle';
  const timeout = 40000;

  try {
    await page.goto(url, { waitUntil, timeout });
  } catch (e) {
    // If networkidle timed out, fall back to just waiting for DOMContentLoaded
    if (e.message && e.message.includes('waiting until "networkidle"')) {
      logger.warn(`[Company] networkidle timeout — falling back to domcontentloaded for ${url.substring(0, 60)}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } else {
      throw e;
    }
  }

  // Extra settle time for SPAs
  if (atsType === 'workday') {
    await page.waitForTimeout(3000).catch(() => {});
  } else {
    await humanDelay(1500, 2500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runCompany — main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ browser, config, db, io, ai }} opts
 */
async function runCompany({ browser, config, db: dbArg, io, ai } = {}) {

  logger.info('[Company] Starting company careers worker');
  if (io) io.emit('portal', { portal: 'Company', status: 'started' });

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
    logger.error('[Company] Could not open page', { err: err.message });
    if (io) io.emit('portal', { portal: 'Company', status: 'error', error: err.message });
    return;
  }

  // ── Collect URLs: config.companyUrls + db queue ───────────────────────────
  const configUrls = (config.companyUrls || []).map(url => ({
    url,
    title:   '',
    company: '',
    portal:  'Company',
    atsType: detectATS(url),
    fromQueue: false,
    queueId: null,
  }));

  let queueItems = [];
  try {
    if (typeof dbInstance.getQueuePending === 'function') {
      queueItems = (dbInstance.getQueuePending() || []).map(item => ({
        url:       item.url,
        title:     item.title   || '',
        company:   item.company || '',
        portal:    item.portal  || 'Company',
        atsType:   item.ats_type || detectATS(item.url),
        fromQueue: true,
        queueId:   item.id,
      }));
    }
  } catch (e) {
    logger.warn(`[Company] Could not fetch queue: ${e.message}`);
  }

  const allItems = [...configUrls, ...queueItems];

  if (allItems.length === 0) {
    logger.info('[Company] No URLs to process (config.companyUrls is empty and queue is empty)');
    if (io) io.emit('portal', { portal: 'Company', status: 'done', applied: 0 });
    await page.close().catch(() => {});
    return;
  }

  logger.info(`[Company] Processing ${allItems.length} URL(s) (${configUrls.length} config, ${queueItems.length} queue)`);
  if (io) io.emit('scraped', { portal: 'Company', count: allItems.length });

  try {
    for (const item of allItems) {
      if (appliedCount >= (config.maxAppsPerRun || 15)) break;

      logger.info(`\n[Company] Processing: ${item.url.substring(0, 80)} [ATS: ${item.atsType}]`);

      let title   = item.title;
      let company = item.company;
      let description = '';
      let screenshot  = null;

      try {
        // ── 1. Navigate ────────────────────────────────────────────────────
        await navigateTo(page, item.url, item.atsType);
        await randomScroll(page);

        // ── 2. Extract metadata ────────────────────────────────────────────
        const meta = await page.evaluate(() => {
          const h1     = document.querySelector('h1')?.textContent?.trim() || '';
          const ogT    = document.querySelector('meta[property="og:title"]')?.content || '';
          const ogSite = document.querySelector('meta[property="og:site_name"]')?.content || '';
          const compEl = document.querySelector('.company-name, [class*="company"]')?.textContent?.trim() || '';
          return {
            title:       h1 || ogT,
            company:     ogSite || compEl,
            description: document.body.innerText.slice(0, 4000),
          };
        }).catch(() => ({ title: '', company: '', description: '' }));

        if (meta.title)       title       = meta.title;
        if (meta.company)     company     = meta.company;
        if (meta.description) description = meta.description;

        logger.info(`[Company] Job: "${title}" @ ${company || '(unknown)'}`);

        // ── 3. AI scoring ─────────────────────────────────────────────────
        let score = 0, decision = 'APPLY', reason = 'no AI';
        const keywords = [
          ...(config.keywords?.required  || []),
          ...(config.keywords?.preferred || []),
        ];

        try {
          if (ai && typeof ai.scoreJob === 'function') {
            ({ score, decision, reason } = await ai.scoreJob({
              title, company, location: '', description, keywords, profile: config.profile || {},
            }));
          } else {
            const r = await analyzeJob(description, config);
            score = r.score; decision = r.decision; reason = r.reason;
          }
        } catch (aiErr) {
          logger.warn(`[Company] AI score failed (using default APPLY): ${aiErr.message}`);
          // Default to APPLY with score 60 when AI fails, so user-provided URLs aren't skipped
          score = 60; decision = 'APPLY'; reason = 'AI unavailable — applying by default';
        }

        logger.info(`[Company] Scored "${title}": ${decision} (${score}) — ${reason}`);
        if (io) io.emit('job_scored', { portal: 'Company', job: { title, company, url: item.url }, score, decision });

        const threshold = config.scoreThreshold || 60;
        if (decision === 'SKIP' && score < threshold) {
          logger.info(`[Company] Skipping "${title}" (score ${score} < threshold ${threshold})`);
          try {
            dbInstance.saveApplication?.({
              jobId: `COMP_${Date.now()}`, portal: item.portal,
              title, company, score, status: 'skipped', aiReason: reason, applyUrl: item.url,
            });
            if (item.fromQueue && item.queueId) {
              dbInstance.updateQueueStatus?.(item.queueId, 'skipped');
            }
          } catch (_) {}
          continue;
        }

        // ── 4. Apply — delegate to externalApplier for known ATS ──────────
        let ok = false;
        let applyStatus = 'failed';

        if (EXTERNAL_APPLIER_ATS.has(item.atsType)) {
          // ── Route to externalApplier which handles multi-step flows ──────
          logger.info(`[Company] Delegating to externalApplier for ATS: ${item.atsType}`);
          try {
            const result = await applyExternal(page, config);
            ok = (result.status === 'success');
            applyStatus = result.status;
            logger.info(`[Company] externalApplier result: ${result.status}`);
          } catch (extErr) {
            logger.warn(`[Company] externalApplier error: ${extErr.message}`);
            applyStatus = 'failed';
          }

        } else {
          // ── Generic form-fill path for unknown / custom career pages ─────

          // 4a. Generate cover letter
          const coverLetter = await coverGen.generate({
            job:     { title, company, location: '', description },
            profile: config.profile,
          }).catch(() => '');

          // 4b. Try to click an Apply button first (many career pages need this)
          const applyBtns = [
            'a:has-text("Apply")', 'button:has-text("Apply")',
            'a:has-text("Apply Now")', 'button:has-text("Apply Now")',
            'a:has-text("Apply for this job")', 'button:has-text("Apply for this job")',
            '[class*="apply-btn"]', '[id*="apply"]',
          ];
          for (const sel of applyBtns) {
            try {
              const btn = page.locator(sel).first();
              if (await btn.count() > 0 && await btn.isVisible()) {
                await btn.click({ timeout: 5000 });
                await humanDelay(2000, 3000);
                logger.info(`[Company] Clicked apply button: ${sel}`);
                break;
              }
            } catch (_) {}
          }

          // 4c. Extract form snapshot
          const filler   = new FormFiller(page, config.profile, config);
          const snapshot = await filler.extractFormSnapshot();
          logger.info(`[Company] Form snapshot: ${snapshot.length} field(s)`);

          // 4d. AI field mapping
          let fieldMap = {};
          try {
            fieldMap = await coverGen.mapFormFields({ formSnapshot: snapshot, profile: config.profile });
            logger.info(`[Company] AI mapped ${Object.keys(fieldMap).length} field(s)`);
          } catch (mapErr) {
            logger.warn(`[Company] mapFormFields failed: ${mapErr.message}`);
          }

          // Inject cover letter into unmapped textareas
          for (const field of snapshot) {
            if (field.type === 'textarea' && !fieldMap[field.selector]) {
              fieldMap[field.selector] = coverLetter || config.profile?.coverLetter || '';
            }
          }

          // 4e. Fill form
          await filler.fillByMap(fieldMap);

          // 4f. Upload resume
          await filler.uploadResume(config.resumePath);

          // 4g. Submit
          ok = await filler.submit();
          applyStatus = ok ? 'applied' : 'failed';
          logger.info(`[Company] Submit result: ${ok ? '✅ success' : '⚠️ unconfirmed'}`);
        }

        // ── 5. Screenshot ──────────────────────────────────────────────────
        screenshot = await takeScreenshot(page, ok ? 'submitted' : 'attempted');

        // ── 6. Save to DB ──────────────────────────────────────────────────
        const status   = ok ? 'applied' : applyStatus;
        const appJobId = `COMP_${item.atsType}_${Date.now()}`;

        try {
          dbInstance.saveApplication?.({
            jobId: appJobId, portal: item.portal,
            title, company, score, status,
            aiReason: reason, screenshot, applyUrl: item.url,
          });
        } catch (_) {}

        if (item.fromQueue && item.queueId) {
          try { dbInstance.updateQueueStatus?.(item.queueId, status); } catch (_) {}
        }

        if (ok) {
          if (io) io.emit('applied', {
            portal: 'Company', job: { title, company, url: item.url }, score, status: 'applied',
          });
          appliedCount++;
        } else {
          if (io) io.emit('error', { portal: 'Company', job: { title, company }, error: `Apply ${applyStatus}` });
        }

      } catch (itemErr) {
        logger.error(`[Company] Error processing ${item.url.substring(0, 60)}: ${itemErr.message}`);

        // Save failure
        try {
          dbInstance.saveApplication?.({
            jobId: `COMP_ERR_${Date.now()}`, portal: item.portal,
            title: title || item.title, company: company || item.company,
            status: 'failed', aiReason: itemErr.message, applyUrl: item.url,
          });
          if (item.fromQueue && item.queueId) {
            dbInstance.updateQueueStatus?.(item.queueId, 'failed');
          }
        } catch (_) {}

        if (io) io.emit('error', { portal: 'Company', url: item.url, error: itemErr.message });
      }

      await humanDelay(config.delayMin || 3000, config.delayMax || 6000);
    }

  } finally {
    if (io) io.emit('portal', { portal: 'Company', status: 'done', applied: appliedCount });
    logger.info(`[Company] Done — applied to ${appliedCount} job(s)`);
    await page.close().catch(() => {});
  }
}

module.exports = { runCompany, detectATS };
