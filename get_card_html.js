const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: 'auth.json' });
  const page = await context.newPage();
  
  await page.goto('https://www.linkedin.com/jobs/search/?f_AL=true&keywords=QA%20Engineer&location=Pune');
  await page.waitForSelector('.job-card-container', { timeout: 15000 });
  
  const cardHtml = await page.locator('.job-card-container').first().innerHTML();
  fs.writeFileSync('card.html', cardHtml);
  
  await browser.close();
  console.log('Saved card HTML');
})();
