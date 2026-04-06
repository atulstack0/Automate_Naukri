'use strict';

/**
 * BrowserManager
 * Wraps Playwright chromium with anti-detection, auth loading, and screenshot helpers.
 *
 * Also exports legacy functions { launchBrowser, saveAuthState, closeBrowser }
 * so that existing callers (worker.js, index.js) don't need any changes.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const logger = require('../utils/logger');
const { patchBrowser } = require('../utils/antiDetection');

const AUTH_PATH        = path.join(process.cwd(), 'auth.json');
const SCREENSHOTS_DIR  = path.join(process.cwd(), 'data', 'screenshots');

// Real Chrome 120+ user-agent pool — rotated per launch
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.160 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.128 Safari/537.36',
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// BrowserManager class
// ─────────────────────────────────────────────────────────────────────────────

class BrowserManager {
  constructor(config = {}) {
    this.config  = config;
    this.browser = null;
    this.context = null;
  }

  /**
   * Launch chromium with anti-detection args, random viewport, rotated UA,
   * and auth.json cookies if the file exists.
   * @returns {Promise<{ browser, context }>}
   */
  async launch() {
    const {
      headless = false,
      slowMo   = 50,
    } = this.config;

    // Random viewport in 1280-1440 x 768-900
    const viewportW = Math.floor(Math.random() * (1440 - 1280 + 1)) + 1280;
    const viewportH = Math.floor(Math.random() * (900  - 768  + 1)) + 768;
    const userAgent = pickRandom(USER_AGENTS);

    logger.info(`[Browser] Launching chromium headless=${headless} viewport=${viewportW}x${viewportH}`);
    logger.info(`[Browser] User-agent: ${userAgent.slice(0, 80)}...`);

    this.browser = await chromium.launch({
      headless,
      slowMo,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-infobars',
        `--window-size=${viewportW},${viewportH}`,
        '--lang=en-US,en',
      ],
    });

    const contextOptions = {
      viewport:   { width: viewportW, height: viewportH },
      userAgent,
      locale:     'en-US',
      timezoneId: 'Asia/Kolkata',
      permissions: ['geolocation'],
      geolocation: { longitude: 73.8567, latitude: 18.5204 }, // Pune
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    };

    // Load auth.json cookies if present
    if (fs.existsSync(AUTH_PATH)) {
      contextOptions.storageState = AUTH_PATH;
      logger.info('[Browser] Loaded auth.json storage state');
    } else {
      logger.info('[Browser] No auth.json — starting fresh');
    }

    this.context = await this.browser.newContext(contextOptions);

    // Patch every page opened from this context automatically
    this.context.on('page', async (page) => {
      try { await patchBrowser(page); } catch (_) {}
    });

    logger.info('[Browser] Launch successful');
    return { browser: this.browser, context: this.context };
  }

  /**
   * Open a new page with stealth patches and Accept-Language header applied.
   * @returns {Promise<import('playwright').Page>}
   */
  async newPage() {
    if (!this.context) throw new Error('[Browser] Call launch() first');
    const page = await this.context.newPage();
    await patchBrowser(page);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    return page;
  }

  /**
   * Save a PNG screenshot to data/screenshots/{label}_{timestamp}.png.
   * @param {import('playwright').Page} page
   * @param {string} label
   * @returns {Promise<string>} absolute file path
   */
  async takeScreenshot(page, label = 'screenshot') {
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }
    const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(SCREENSHOTS_DIR, `${safeName}_${Date.now()}.png`);
    try {
      await page.screenshot({ path: filePath, fullPage: false });
      logger.debug(`[Browser] Screenshot saved: ${filePath}`);
    } catch (err) {
      logger.warn(`[Browser] Screenshot failed: ${err.message}`);
    }
    return filePath;
  }

  /**
   * Close the browser gracefully.
   */
  async close() {
    try { await this.browser.close(); } catch (_) {}
    this.browser = null;
    this.context = null;
    logger.info('[Browser] Closed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy function exports
// Used by existing src/index.js, src/worker/worker.js callers.
// ─────────────────────────────────────────────────────────────────────────────

async function launchBrowser(config = {}) {
  const bm = new BrowserManager(config);
  return bm.launch(); // returns { browser, context }
}

async function saveAuthState(context) {
  await context.storageState({ path: AUTH_PATH });
  logger.info('[Browser] Auth state saved to auth.json');
}

async function closeBrowser(browser, context) {
  try { if (context) await context.close(); } catch (_) {}
  try { if (browser)  await browser.close();  } catch (_) {}
  logger.info('[Browser] Closed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = BrowserManager;

// Attach legacy functions as named exports on the class so both require styles work:
//   const BM = require('./browser');  new BM(config).launch()   ← class style
//   const { launchBrowser } = require('./browser');              ← legacy style
module.exports.BrowserManager  = BrowserManager;
module.exports.launchBrowser   = launchBrowser;
module.exports.saveAuthState   = saveAuthState;
module.exports.closeBrowser    = closeBrowser;
