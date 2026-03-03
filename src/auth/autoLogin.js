'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const logger = require('../utils/logger');

const AUTH_PATH = path.join(process.cwd(), 'auth.json');

/**
 * Handle scenarios where the bot detects it is logged out during a run.
 * It opens a visible browser, prompts the user to log in, captures the credentials,
 * merges them with existing credentials in auth.json, and closes.
 * 
 * @param {string} platform 'naukri' | 'linkedin'
 * @returns {Promise<boolean>} true if login was successful
 */
async function handleLoginRequired(platform) {
  let targetUrl = 'https://www.naukri.com/nlogin/login';
  if (platform === 'linkedin') {
    targetUrl = 'https://www.linkedin.com/login';
  }

  logger.warn(`\n[AutoLogin] 🛑 ACTION REQUIRED: You are logged out of ${platform.toUpperCase()}.`);
  logger.info(`[AutoLogin] Pausing bot. Opening a visible browser for manual login...`);

  // Launch a new, completely visible browser for the user
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
    viewport: { width: 1366, height: 768 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
  };

  // Load existing credentials so we can merge them
  if (fs.existsSync(AUTH_PATH)) {
    contextOptions.storageState = AUTH_PATH;
  }

  const context = await browser.newContext(contextOptions);

  // Remove webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  logger.info(`[AutoLogin] Please log into your ${platform} account in the newly opened window.`);
  
  if (platform === 'linkedin') {
    logger.info('[AutoLogin] Waiting up to 5 minutes for successful login (feed page detected)...');
    try {
      await page.waitForURL(/.*linkedin\.com\/feed.*/, { timeout: 300000 });
      logger.info('[AutoLogin] Feed page detected. Saving credentials...');
      await page.waitForTimeout(2000); // let cookies finalize
    } catch (e) {
      logger.error('[AutoLogin] Timed out waiting for LinkedIn login.');
      await browser.close();
      return false;
    }
  } else {
    // Naukri
    logger.info('[AutoLogin] Waiting up to 5 minutes for successful login (homepage/user profile detected)...');
    try {
      // Check for elements that indicate logged in state on naukri
      await page.waitForFunction(() => {
        return window.location.href.includes('mnjuser/profile') || 
               document.querySelector('.nI-gNb-drawer__icon') || 
               document.querySelector('.user-name');
      }, { timeout: 300000 });
      logger.info('[AutoLogin] Naukri login verified. Saving credentials...');
      await page.waitForTimeout(2000);
    } catch (e) {
      logger.error('[AutoLogin] Timed out waiting for Naukri login.');
      await browser.close();
      return false;
    }
  }

  // Save the merged state back to auth.json
  await context.storageState({ path: AUTH_PATH });
  logger.info(`[AutoLogin] ✅ Credentials successfully saved. Resuming bot...`);
  
  await browser.close();
  return true;
}

module.exports = { handleLoginRequired };
