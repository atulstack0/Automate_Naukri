'use strict';

const { launchBrowser, closeBrowser } = require('./browser/browser');

async function testChatbot() {
  const { browser, context } = await launchBrowser({ headless: false, slowMo: 50, useAuth: true });
  const page = await context.newPage();
  
  const targetUrl = 'https://www.naukri.com/job-listings-qa-engineer-worldline-pune-6-to-10-years-050226011104';
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  
  // Click apply if possible
  const APPLY_SELECTORS = ['#apply-button', '.apply-button', 'button:has-text("Apply")'];
  for (const sel of APPLY_SELECTORS) {
     const btn = page.locator(sel).first();
     if (await btn.count() > 0 && await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(5000);
        break;
     }
  }

  const info = await page.evaluate(() => {
    // Find any element that might be a text input
    const els = Array.from(document.querySelectorAll('*'));
    return els
      .filter(el => {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
        if (el.isContentEditable) return true;
        if (el.className && typeof el.className === 'string' && el.className.toLowerCase().includes('input')) return true;
        if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return true;
        if (el.innerText && el.innerText.includes('Type message here')) return true;
        return false;
      })
      .map(el => ({
        tag: el.tagName,
        id: el.id,
        class: typeof el.className === 'string' ? el.className : '',
        placeholder: el.placeholder || el.getAttribute('placeholder') || '',
        contentEditable: el.isContentEditable,
        text: el.innerText ? el.innerText.substring(0, 30) : ''
      }));
  });
  console.log(JSON.stringify(info, null, 2));
  await closeBrowser(browser, context);
}

testChatbot().catch(err => console.error(err));
