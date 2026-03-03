const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({ storageState: 'auth.json' });
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/jobs/search/?f_AL=true&keywords=QA%20Engineer&location=Pune', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.job-card-container', { timeout: 15000 });
  await page.locator('.job-card-container').first().click();
  await page.waitForTimeout(3000); // let right pane load
  const body = await page.innerHTML('body');
  fs.writeFileSync('details_dom.html', body);
  await browser.close();
  console.log('Saved non-headless details_dom.html');
})();
