'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const AUTH_PATH = path.join(process.cwd(), 'auth.json');

/**
 * Launch a persistent Playwright browser context.
 * If auth.json exists, storage state is loaded automatically.
 */
async function launchBrowser(config = {}) {
  const {
    headless = false,
    slowMo = 50,
    useAuth = true,
  } = config;

  const launchOptions = {
    headless,
    slowMo,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1366,768',
      '--disable-dev-shm-usage',
      '--lang=en-US,en',
    ],
  };

  const browser = await chromium.launch(launchOptions);

  const contextOptions = {
    viewport: { width: 1366, height: 768 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
    permissions: ['geolocation'],
    geolocation: { longitude: 77.209, latitude: 28.6139 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  };

  if (useAuth && fs.existsSync(AUTH_PATH)) {
    contextOptions.storageState = AUTH_PATH;
    logger.info('Loading session from auth.json');
  } else {
    logger.info('No auth.json found – starting fresh session');
  }

  const context = await browser.newContext(contextOptions);

  // Stealth: remove webdriver fingerprint
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  logger.info(`Browser launched: headless=${headless}, slowMo=${slowMo}ms`);
  return { browser, context };
}

/**
 * Save storage state to auth.json.
 */
async function saveAuthState(context) {
  await context.storageState({ path: AUTH_PATH });
  logger.info('Auth state saved to auth.json');
}

/**
 * Close browser and context gracefully.
 */
async function closeBrowser(browser, context) {
  try {
    if (context) await context.close();
    if (browser) await browser.close();
    logger.info('Browser closed');
  } catch (err) {
    logger.warn('Error closing browser', { err: err.message });
  }
}

module.exports = { launchBrowser, saveAuthState, closeBrowser };
