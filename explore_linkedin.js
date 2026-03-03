const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  });
  
  // Try loading auth status if it helps, though we know linkedin isn't there yet
  if (fs.existsSync('auth.json')) {
    const auth = JSON.parse(fs.readFileSync('auth.json'));
    await context.addCookies(auth.cookies || []);
  }

  const page = await context.newPage();
  console.log('Navigating to LinkedIn Jobs...');
  await page.goto('https://www.linkedin.com/jobs/search/?keywords=QA%20Engineer&location=Pune', { waitUntil: 'domcontentloaded' });
  
  // Wait a bit for JS to load the jobs
  await page.waitForTimeout(5000);
  
  const html = await page.content();
  const outPath = path.join(process.cwd(), 'linkedin_dom.html');
  fs.writeFileSync(outPath, html);
  
  console.log('Saved DOM to', outPath);
  console.log('Current URL:', page.url());
  
  await browser.close();
})();
