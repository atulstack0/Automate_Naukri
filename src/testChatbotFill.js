'use strict';

const { launchBrowser, closeBrowser } = require('./browser/browser');
const { fillFormSmart } = require('./worker/formFiller');
const { initAIProvider } = require('./ai/aiProvider');
const config = require('../config/config.json');

async function debugChatbot() {
  initAIProvider(config);
  const { browser, context } = await launchBrowser({ headless: false, slowMo: 50, useAuth: true });
  const page = await context.newPage();
  
  const targetUrl = 'https://www.naukri.com/myapply/showAcp?jquery=1&file=300126506650&multiApplyResp={%22300126506650%22:202}';
  
  page.on('console', msg => {
    if (msg.type() === 'log' || msg.type() === 'info' || msg.type() === 'debug') {
        console.log(`[Page] ${msg.text()}`);
    }
  });

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  
  // Directly wait for the chatbot container since we hit the chatbot URL
  try {
      await page.waitForSelector('.naukri-drawer, .chatbot_InputContainer, .chatbot_MessagesContainer', { timeout: 10000 });
      console.log('[DEBUG] Chatbot Context loaded!');
  } catch (e) {
      console.log('[DEBUG] Chatbot container not found...', e.message);
  }

  console.log('Running test fill...');
  // Only target the apply container so we bypass rest of the page
  const scope = config.selector.applyModal;

  // Debug: Dump the HTML of the scope
  const scopeHtml = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.outerHTML : 'Scope element not found';
  }, scope);
  console.log('[DEBUG] Scope HTML length:', scopeHtml.length);
  if (scopeHtml.length < 500) {
      console.log('[DEBUG] Scope HTML:', scopeHtml);
  } else {
      console.log('[DEBUG] Scope HTML excerpt:', scopeHtml.substring(0, 500) + '...');
  }

  await fillFormSmart(page, { ...config, scopeSelector: scope });
  
  console.log('Fill complete. Waiting 10 seconds...');
  await page.waitForTimeout(10000);
  await closeBrowser(browser, context);
}

debugChatbot().catch(err => console.error(err));
