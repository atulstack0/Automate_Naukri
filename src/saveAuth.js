'use strict';

/**
 * saveAuth.js
 * Launch a visible browser and let the user log into each configured portal.
 * For each non-empty URL (jobsUrl, linkedinUrl, indeedUrl), navigates to it,
 * prints a prompt, then waits for ENTER before moving to the next.
 * Finally saves auth cookies to auth.json.
 *
 * Usage: npm run save-auth
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const logger   = require('./utils/logger');

const AUTH_PATH = path.join(process.cwd(), 'auth.json');

let config;
try {
  config = require(path.join(process.cwd(), 'config', 'config.json'));
} catch (_) {
  config = {};
}

// Collect non-empty portal URLs from config
const portals = [
  { name: 'Naukri / Main',  url: config.jobsUrl     || '' },
  { name: 'LinkedIn',       url: config.linkedinUrl  || '' },
  { name: 'Indeed',         url: config.indeedUrl    || '' },
].filter(p => p.url.trim() !== '');

if (portals.length === 0) {
  console.error('[SaveAuth] No portal URLs configured in config.json (jobsUrl / linkedinUrl / indeedUrl)');
  process.exit(1);
}

/** Wait for the user to press ENTER in the terminal. */
function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

(async () => {
  logger.info('=== AutoApply Auth Saver ===');
  logger.info(`Portals to authenticate: ${portals.map(p => p.name).join(', ')}`);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 30,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
    ],
  });

  const contextOptions = {
    viewport:   { width: 1366, height: 768 },
    userAgent:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.160 Safari/537.36',
    locale:     'en-US',
    timezoneId: 'Asia/Kolkata',
  };

  // Pre-load existing auth.json so we don't lose previously saved cookies
  if (fs.existsSync(AUTH_PATH)) {
    logger.info('[SaveAuth] Found existing auth.json — merging credentials');
    contextOptions.storageState = AUTH_PATH;
  }

  const context = await browser.newContext(contextOptions);

  // Basic webdriver removal
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  // ── Loop over each portal ──────────────────────────────────────────────────
  for (const portal of portals) {
    logger.info(`\n[SaveAuth] Navigating to: ${portal.url}`);
    try {
      await page.goto(portal.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      logger.warn(`[SaveAuth] Navigation warning for ${portal.name}: ${err.message}`);
    }

    // Special case: LinkedIn — auto-detect feed page
    if (portal.url.includes('linkedin.com')) {
      logger.info(`[SaveAuth] Log into LinkedIn, then wait for the feed page to load...`);
      try {
        await page.waitForURL(/linkedin\.com\/feed/, { timeout: 300000 });
        logger.info('[SaveAuth] LinkedIn feed detected — login confirmed!');
        await page.waitForTimeout(2000);
      } catch (_) {
        logger.warn('[SaveAuth] Feed page not detected within 5 min.');
        await waitForEnter(`Log into ${portal.name} (${portal.url}) — then press ENTER to continue... `);
      }
    } else {
      await waitForEnter(`Log into ${portal.name} (${portal.url}) — then press ENTER to continue... `);
    }

    logger.info(`[SaveAuth] ✅ ${portal.name} session captured`);
  }

  // ── Save combined auth state ───────────────────────────────────────────────
  logger.info(`\n[SaveAuth] Saving auth state to: ${AUTH_PATH}`);
  await context.storageState({ path: AUTH_PATH });

  const size = fs.statSync(AUTH_PATH).size;
  logger.info(`[SaveAuth] ✅ auth.json saved (${size} bytes)`);

  // Validate LinkedIn cookie if it was configured
  if (portals.some(p => p.url.includes('linkedin'))) {
    const cookies = await context.cookies();
    const hasLiAt = cookies.some(c => c.name === 'li_at');
    if (hasLiAt) {
      logger.info('[SaveAuth] ✅ LinkedIn li_at cookie present — login successful');
    } else {
      logger.warn('[SaveAuth] ⚠️  LinkedIn li_at cookie NOT found — login may have failed');
    }
  }

  await browser.close();
  console.log('\nAuth saved to auth.json');
  process.exit(0);
})().catch(err => {
  logger.error('[SaveAuth] Fatal error', { message: err.message, stack: err.stack });
  process.exit(1);
});
