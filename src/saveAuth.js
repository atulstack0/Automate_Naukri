'use strict';

/**
 * saveAuth.js
 * Run once to open a visible browser, let the user log in manually, then save auth.json.
 * Usage: node src/saveAuth.js
 */

const path = require('path');
const { chromium } = require('playwright');
const logger = require('./utils/logger');

const AUTH_PATH = path.join(process.cwd(), 'auth.json');
let config;

try {
  config = require(path.join(process.cwd(), 'config', 'config.json'));
} catch (_) {
  config = {};
}

const TARGET_URL = config.jobsUrl || 'https://www.naukri.com/nlogin/login';

(async () => {
  logger.info('=== AutoApply Auth Saver ===');
  logger.info(`Opening browser. Please log into: ${TARGET_URL}`);
  logger.info('When done, press ENTER in this terminal to save auth.json and close.');

  logger.info('[AuthSaver] Launching browser for manual session capture...');
  const browser = await chromium.launch({
    headless: false,
    slowMo: 30,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
    ],
  });

  logger.debug('[AuthSaver] Creating new context and disabling automation flags');
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
  });

  // Remove webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  logger.info(`[AuthSaver] Navigating to target: ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

  // Wait for user input
  logger.info('[AuthSaver] ! ACTION REQUIRED: Use the browser window to log in manually.');
  logger.info('[AuthSaver] ! Once logged in, press ENTER in this terminal to capture credentials.');

  await new Promise(resolve => {
    process.stdin.once('data', () => resolve());
    process.stdin.resume();
  });

  // Save auth state
  logger.info(`[AuthSaver] Capturing storage state to: ${AUTH_PATH}...`);
  await context.storageState({ path: AUTH_PATH });
  logger.info(`[AuthSaver] ✅ SUCCESS: auth.json created (${fs.statSync(AUTH_PATH).size} bytes)`);

  await browser.close();
  logger.info('[AuthSaver] Browser closed. Process complete.');
  process.exit(0);
})().catch(err => {
  logger.error('saveAuth failed', { message: err.message, stack: err.stack });
  process.exit(1);
});
