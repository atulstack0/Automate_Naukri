'use strict';

const { launchBrowser, closeBrowser } = require('./browser/browser');
const config = require('../config/config.json');
const { fillFormSmart } = require('./worker/formFiller');
const { initAIProvider } = require('./ai/aiProvider');
const logger = require('./utils/logger');

initAIProvider(config);

async function testApply() {
  logger.info("Launching browser with Auth...");
  const { browser, context } = await launchBrowser({ headless: false, slowMo: 50, useAuth: true });
  const page = await context.newPage();
  
  const targetUrl = 'https://www.naukri.com/myapply/showAcp?jquery=1&file=300126506650&multiApplyResp={%22300126506650%22:202}';
  logger.info(`Navigating to ${targetUrl}`);
  
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  logger.info("Waiting 5 seconds for form to render...");
  await page.waitForTimeout(5000);
  
  logger.info("Executing Form Filler on the targeted page...");
  const scope = config.selector.applyModal || '.apply-modal, .apply-drawer, [class*="apply"]';
  const unmatched = await fillFormSmart(page, { ...config, scopeSelector: scope });
  
  logger.info(`Test complete. Unmatched fields: ${JSON.stringify(unmatched)}`);
  
  logger.info("Browser will remain open for 30 seconds for visual inspection...");
  await page.waitForTimeout(30000);
  
  await closeBrowser(browser, context);
}

testApply().catch(err => logger.error("Test failed", { err: err.message }));
