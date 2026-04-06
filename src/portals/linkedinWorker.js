'use strict';

/**
 * linkedinWorker.js – automation for LinkedIn Easy Apply
 */

const path = require('path');
const fs = require('fs');
const { launchBrowser, closeBrowser } = require('../browser/browser');
const { analyzeJob } = require('../ai/ollamaClient');
const { fillFormSmart } = require('../worker/formFiller');
const db = require('../db/db');
const logger = require('../utils/logger');
const { handleLoginRequired } = require('../auth/autoLogin');
const { randomDelay, humanClick, randomScroll, backoff, highlightAndClick } = require('../utils/antiDetection');

let emitEvent = () => {};
function setEmitter(fn) { emitEvent = fn; }

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
    .substring(0, 100).toLowerCase();
}

async function captureScreenshot(page, jobId, stage) {
  try {
    const now = new Date();
    const ts = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' IST');
    const tsFile = now.toISOString().replace(/[:T]/g, '-').replace(/\.\d+Z$/, '');

    const dir = path.dirname(screenshotPath(jobId, stage));
    const filePath = path.join(dir, `${jobId}_${stage}_${tsFile}.png`);

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

// ── LinkedIn Flow ─────────────────────────────────────────────────────────

async function performLinkedinSearch(page, keyword, location = '') {
  logger.info(`\n[Search] ── Searching LinkedIn: "${keyword}" in "${location || 'All Locations'}" ──`);
  const encodedKeyword = encodeURIComponent(keyword);
  const encodedLocation = encodeURIComponent(location);
  
  // Directly navigate to LinkedIn job search URL with parameters
  // Using f_AL=true to strictly filter by "Easy Apply"
  const searchUrl = `https://www.linkedin.com/jobs/search/?f_AL=true&keywords=${encodedKeyword}&location=${encodedLocation}`;
  
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(2500, 4000);
  
  // Verify if it logged in properly
  const isLoggedOut = await page.locator('.btn-secondary-emphasis:has-text("Sign in")').count() > 0;
  if (isLoggedOut) {
    logger.warn('[LinkedIn] Bot appears to be logged out. Automation may fail.');
  }

  // Check if no results found
  const noResults = await page.locator('.jobs-search-two-pane__no-results-banner, :has-text("No matching jobs found")').count() > 0;
  if (noResults) {
    logger.warn(`[LinkedIn] No results found for "${keyword}" in "${location}"`);
    return null;
  }

  logger.info('[LinkedIn] Successfully loaded search page');
  return searchUrl;
}

async function applyToLinkedinJob(page, jobId, config) {
  const { maxRetries = 3 } = config;
  let unmatched = [];

  const EASY_APPLY_SELECTORS = [
    '.jobs-apply-button--top-card button.jobs-apply-button',
    'button.jobs-apply-button',
    'button:has-text("Easy Apply")',
    '[data-control-name="jobdetails_topcard_inapply"]'
  ];

  const NEXT_BTN_SELECTORS = [
    'button[aria-label="Continue to next step"]',
    'button:has-text("Next")',
    'button:has-text("Review")'
  ];

  const SUBMIT_SELECTORS = [
    'button[aria-label="Submit application"]',
    'button:has-text("Submit application")',
    'button:has-text("Submit")'
  ];

  const SUCCESS_SELECTORS = [
    'h3:has-text("Your application was sent")',
    '[class*="artdeco-modal__header"]:has-text("Application sent")',
    'button:has-text("Done")'
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        logger.info(`Retry ${attempt}/${maxRetries} for ${jobId}`);
        await backoff(attempt);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        await randomDelay(2000, 3000);
      }

      // Check if already applied
      const appliedSelectors = [
        '.artdeco-inline-feedback__message:has-text("Applied")',
        '.artdeco-inline-feedback--success:has-text("Applied")',
        'span.t-bold:has-text("Applied")'
      ];
      
      for (const sel of appliedSelectors) {
        if (await page.locator(sel).count() > 0) {
          logger.info(`Already applied to this job on LinkedIn: ${jobId}`);
          return { status: 'already_applied', unmatched };
        }
      }

      let applyClicked = false;
      for (const sel of EASY_APPLY_SELECTORS) {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0 && await btn.isVisible()) {
          logger.info(`[Worker] Clicking EASY APPLY: "${sel}"`);
          await btn.click({ timeout: 10000 });
          applyClicked = true;
          await randomDelay(1500, 2500);
          break;
        }
      }

      if (!applyClicked) {
        // If it's a regular "Apply" instead of "Easy Apply", it redirects offsite
        const externalApplyBtn = await page.locator('button:has-text("Apply")').count();
        if (externalApplyBtn > 0) {
           return { status: 'external', unmatched };
        }
        
        logger.warn(`No Easy Apply button found for ${jobId}`);
        if (attempt >= maxRetries) return { status: 'failed', unmatched };
        continue;
      }

      await captureScreenshot(page, jobId, 'opened_modal');

      let blockResumeUpload = false;
      let reviewClicked = false;
      
      // Step through modal forms (up to 10 pages)
      for (let step = 0; step < 10; step++) {
        logger.info(`\n[Worker] Job ${jobId}: Processing LinkedIn Form Step ${step + 1}...`);
        
        // Target the modal body specifically
        const scope = '.jobs-easy-apply-modal';
        await page.waitForSelector(scope, { state: 'attached', timeout: 5000 }).catch(() => {});
        
        const stepUnmatched = await fillFormSmart(page, { ...config, scopeSelector: scope, blockResumeUpload });
        if (stepUnmatched.length) unmatched.push(...stepUnmatched);

        await randomDelay(600, 1200);
        await captureScreenshot(page, jobId, `form_step_${step + 1}`);

        // Are we on the success screen?
        let successFound = false;
        for (const sel of SUCCESS_SELECTORS) {
          if (await page.locator(sel).count() > 0 && await page.locator(sel).first().isVisible()) {
            successFound = true; break;
          }
        }
        if (successFound) {
          logger.info(`Success detected at step ${step + 1}`);
          const doneBtn = page.locator('button:has-text("Done")').first();
          if (await doneBtn.count() > 0) await doneBtn.click().catch(()=>{});
          await captureScreenshot(page, jobId, 'submitted');
          return { status: 'success', unmatched };
        }

        // Try submitting
        let submitted = false;
        const modal = page.locator('.jobs-easy-apply-modal').first();
        for (const sel of SUBMIT_SELECTORS) {
          const btn = modal.locator(sel).first();
          if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
            await btn.click();
            await randomDelay(2000, 3000);
            submitted = true;
            logger.info(`[Worker] Clicked SUBMIT: "${sel}" (within modal)`);
            break;
          }
        }

        if (submitted) {
          // Verify success
          for (const sSel of SUCCESS_SELECTORS) {
            if (await page.locator(sSel).count() > 0) {
              const doneBtn = page.locator('button:has-text("Done")').first();
              if (await doneBtn.count() > 0) await doneBtn.click().catch(()=>{});
              await captureScreenshot(page, jobId, 'submitted');
              return { status: 'success', unmatched };
            }
          }
          break; // broke out of submit attempt
        }

        // Try Next/Review
        let advanced = false;
        for (const sel of NEXT_BTN_SELECTORS) {
          const btn = modal.locator(sel).first();
          if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
            await btn.click();
            await randomDelay(1000, 2000);
            advanced = true;
            logger.info(`[Worker] Clicked NEXT/REVIEW: "${sel}" (within modal)`);
            break;
          }
        }

        if (!advanced) {
          // Check for errors blocks
          const errorIcon = await page.locator('.artdeco-inline-feedback--error').count();
          if (errorIcon > 0) {
            logger.warn(`[Worker] Form has validation errors – retrying step ${step + 1} with AI correction...`);
            continue; 
          }
          logger.warn(`No next/submit button on step ${step + 1} – breaking`);
          break;
        }
      }

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

async function runLinkedinWorker(config) {
  const {
    headless = false,
    slowMo = 20,
    delayMin = 1500,
    delayMax = 3000,
    maxAppsPerRun = 20,
    safetyMode = false,
    scoreThreshold = 50,
    searchKeywords = [],
    searchLocation = '',
    jobsUrl,
  } = config;

  const searchEntries = searchKeywords.length
    ? searchKeywords.map(kw => ({ keyword: kw, url: null }))
    : [{ keyword: null, url: jobsUrl }];

  if (!searchKeywords.length && !jobsUrl) {
    logger.error('Either searchKeywords or jobsUrl is required in config/config.json');
    return;
  }

  logger.info('=== AutoApply LinkedIn Worker Starting ===');
  emitEvent('worker:start', { config: { jobsUrl, maxAppsPerRun } });

  let { browser, context } = await launchBrowser({ headless, slowMo, useAuth: true });
  let page = await context.newPage();

  // ── Auto-Login Check ───────────────────────────────────────────────────
  logger.info(`[Worker] Verifying LinkedIn login status...`);
  await page.goto('https://www.linkedin.com/feed', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(2000, 3000);

  // Check if logged out (e.g., redirected to login/signup or showing sign in button)
  const isLoggedIn = await page.evaluate(() => {
    return !window.location.href.includes('linkedin.com/signup') &&
           !window.location.href.includes('linkedin.com/login') &&
           !document.querySelector('form.join-form') &&
           !document.querySelector('.authwall-join-form');
  });

  if (!isLoggedIn) {
    logger.warn(`[Worker] User is logged out of LinkedIn. Initiating auto-login protocol...`);
    await closeBrowser(browser, context);
    
    const loginSuccess = await handleLoginRequired('linkedin');
    if (!loginSuccess) {
      logger.error(`[Worker] Auto-login failed or timed out. Aborting run.`);
      emitEvent('worker:error', { message: 'LinkedIn auto-login failed' });
      return;
    }

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

      let currentJobsUrl = entry.url;
      if (entry.keyword) {
        currentJobsUrl = await performLinkedinSearch(page, entry.keyword, searchLocation);
      } else {
        await page.goto(currentJobsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 4000);
      }

      let pageNum = 1;

      outerLoop: while (appliedCount < maxAppsPerRun) {
        logger.info(`Scraping LinkedIn page ${pageNum}...`);
        
        // Scroll left job list pane
        const listSelector = '.jobs-search-results-list';
        await page.waitForSelector(listSelector, { timeout: 15000 }).catch(() => {});
        const jobList = page.locator(listSelector);
        if (await jobList.count() > 0) {
           for (let i = 0; i < 5; i++) {
             await jobList.evaluate(el => { el.scrollBy(0, 500); });
             await randomDelay(500, 1000);
           }
        }

        const cardSel = '.job-card-container';
        const cards = page.locator(cardSel);
        const count = await cards.count();
        logger.info(`Found ${count} cards on page ${pageNum}`);

        if (count === 0) {
          logger.warn('No job cards found on LinkedIn. End of search or rate limited.');
          break;
        }

        for (let i = 0; i < count; i++) {
          if (appliedCount >= maxAppsPerRun) break outerLoop;

          const card = cards.nth(i);
          scannedCount++;
          
          let title = 'Unknown';
          let company = 'Unknown';
          let location = 'Unknown';
          let cardUrl = '';
          
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
            if (cardUrl.startsWith('/')) cardUrl = `https://www.linkedin.com${cardUrl}`;
            
            // Click the card in the list to open it in the right pane
            await highlightAndClick(page, card, `Select ${title.substring(0, 15)}`);
            await randomDelay(1500, 2500);
            
          } catch (e) {
            logger.debug('[Worker] Partial scrape failed for card', { err: e.message });
          }

          const jobId = makeJobId(title, company);
          logger.info(`\n[${scannedCount}] "${title}" @ ${company}`);

          const existing = db.getJob(jobId);
          if (existing?.apply_status === 'success') {
            logger.info(`Already applied – skipping: ${jobId}`);
            skippedCount++;
            continue;
          }

          // Read the right pane text for AI
          const jobDetailsPane = page.locator('.jobs-search__job-details--container, .job-view-layout').first();
          let jobText = '';
          if (await jobDetailsPane.count() > 0) {
             const seeMore = jobDetailsPane.locator('button:has-text("See more")').first();
             if (await seeMore.count() > 0 && await seeMore.isVisible()) {
               await seeMore.click().catch(()=>{});
             }
             jobText = await jobDetailsPane.innerText().catch(() => '');
          }

          const aiResult = await analyzeJob(jobText, config);
          logger.info(`AI: ${aiResult.decision} (${aiResult.score}) – ${aiResult.reason}`);

          db.upsertJob({
            job_id: jobId, title, company, location, url: cardUrl,
            description: jobText.substring(0, 5000),
            decision: aiResult.decision, score: aiResult.score, reason: aiResult.reason,
            apply_status: aiResult.decision === 'SKIP' ? 'skipped' : 'pending',
          });

          emitEvent('job:analyzed', { jobId, title, company, ...aiResult });

          if (aiResult.decision === 'APPLY' && aiResult.score >= scoreThreshold) {
            const safetyExtra = safetyMode ? 1000 : 0;
            await randomDelay(500 + safetyExtra, 1000 + safetyExtra);

            logger.info(`Applying: "${title}" @ ${company}`);
            emitEvent('job:applying', { jobId, title, company });

            const { status: applyResult, unmatched } = await applyToLinkedinJob(page, jobId, config);
            const appliedAt = new Date().toISOString();

            if (unmatched?.length) {
              allUnmatched.push(...unmatched.map(u => ({ ...u, job: title })));
            }

            if (applyResult === 'success' || applyResult === 'already_applied') {
              appliedCount++;
              appliedJobLinks.push({ title, company, url: cardUrl });
              db.updateJobApplyStatus(jobId, 'success', null, appliedAt);
              logger.info(`✅ Applied [${appliedCount}]: ${title}`);
              emitEvent('job:applied', { jobId, title, company, appliedCount });
            } else if (applyResult === 'external') {
              externalCount++;
              externalJobLinks.push({ title, company, url: cardUrl });
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

          await randomDelay(delayMin, delayMax);
        }

        // Next page pagination
        const pagination = page.locator('.artdeco-pagination__pages, .jobs-search-results-list__pagination');
        if (await pagination.count() > 0) {
           // Try by aria-label first (Page X), then by finding the button with "Next" or an arrow
           let nextBtn = page.locator(`button[aria-label="Page ${pageNum + 1}"], [aria-label*="Page ${pageNum + 1}"]`).first();
           
           if (await nextBtn.count() === 0) {
             // Fallback: look for the "Next" button by text or common class
             nextBtn = page.locator('.artdeco-pagination__button--next, button:has-text("Next")').first();
           }

           if (await nextBtn.count() > 0 && await nextBtn.isVisible() && await nextBtn.isEnabled()) {
             logger.info(`Going to page ${pageNum + 1}`);
             await nextBtn.scrollIntoViewIfNeeded();
             await nextBtn.click();
             await randomDelay(3000, 5000);
             pageNum++;
           } else {
             logger.info('No next page – scanning complete');
             break;
           }
        } else {
           break;
        }
      } 
    }

  } catch (err) {
    logger.error('Worker fatal error', { message: err.message, stack: err.stack });
    emitEvent('worker:error', { message: err.message });
  } finally {
    await closeBrowser(browser, context);

    logger.info('=== Session Summary ===');
    logger.info(`  Total scanned : ${scannedCount}`);
    logger.info(`  Applied       : ${appliedCount}`);
    logger.info(`  Skipped (AI)  : ${skippedCount}`);
    logger.info(`  External sites: ${externalCount}`);
    logger.info(`  Errors        : ${errorCount}`);
  }
}

module.exports = { runLinkedinWorker, setEmitter };
