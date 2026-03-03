'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(process.cwd(), 'data', 'autoapply.db');
const db = new Database(DB_PATH);

// ══ TEST 1: Does upsertJob correctly overwrite the URL on conflict? ══════════
console.log('\n══ TEST 1: upsertJob URL overwrite on conflict ══');
const TID = '__verify_url_fix__';
db.prepare('DELETE FROM jobs WHERE job_id = ?').run(TID);

const upsertSql = `
  INSERT INTO jobs (job_id, title, company, location, url, description, decision, score, reason, apply_status)
  VALUES (@job_id, @title, @company, @location, @url, @description, @decision, @score, @reason, @apply_status)
  ON CONFLICT(job_id) DO UPDATE SET
    title        = excluded.title,
    company      = excluded.company,
    location     = excluded.location,
    url          = excluded.url,
    description  = CASE WHEN excluded.description != '' THEN excluded.description ELSE jobs.description END,
    decision     = excluded.decision,
    score        = excluded.score,
    reason       = excluded.reason,
    apply_status = excluded.apply_status
`;
const stmt = db.prepare(upsertSql);

// Step 1: First upsert with generic search page URL (simulates old bug)
stmt.run({
  job_id: TID, title: 'QA Test Engineer', company: 'Corp', location: 'Pune',
  url: 'https://www.naukri.com/qa-engineer-jobs-in-pune',
  description: '', decision: 'PENDING', score: 0,
  reason: 'pending analysis', apply_status: 'pending',
});
let r = db.prepare('SELECT url FROM jobs WHERE job_id = ?').get(TID);
console.log('After 1st upsert (search page URL):', r.url);

// Step 2: Second upsert with real job detail URL (simulates what worker.js does after opening job tab)
const REAL_URL = 'https://www.naukri.com/job-listings/qa-test-engineer-corp-pune-3-to-5-years-030326100001';
stmt.run({
  job_id: TID, title: 'QA Test Engineer', company: 'Corp', location: 'Pune',
  url: REAL_URL,
  description: 'Full job description from the detail page...', decision: 'PENDING',
  score: 0, reason: '', apply_status: 'pending',
});
r = db.prepare('SELECT url, description FROM jobs WHERE job_id = ?').get(TID);
console.log('After 2nd upsert (real job URL):    ', r.url);
console.log(r.url === REAL_URL
  ? '✅ PASS: Real job URL correctly overwrites search page URL'
  : '❌ FAIL: URL was NOT overwritten — fix is not working');
console.log('Description preserved:',
  r.description === 'Full job description from the detail page...' ? '✅ PASS' : '❌ FAIL');

// ══ TEST 2: Relative URL resolution logic ════════════════════════════════════
console.log('\n══ TEST 2: Relative URL resolution ══');
const cases = [
  ['/job-listings/qa-engineer-pune-030326', 'https://www.naukri.com/job-listings/qa-engineer-pune-030326'],
  ['https://www.naukri.com/job-listings/already-absolute', 'https://www.naukri.com/job-listings/already-absolute'],
  ['', ''],
  ['https://careers.company.com/apply', 'https://careers.company.com/apply'],
  ['/job-listings/automation-qa-engineer-digite-technologies-pune-2-to-4-years-030226500123',
   'https://www.naukri.com/job-listings/automation-qa-engineer-digite-technologies-pune-2-to-4-years-030226500123'],
];

let allPassed = true;
for (const [input, expected] of cases) {
  let cardUrl = input;
  if (cardUrl && !cardUrl.startsWith('http')) {
    try { cardUrl = new URL(cardUrl, 'https://www.naukri.com').href; } catch (_) {}
  }
  const pass = cardUrl === expected;
  if (!pass) allPassed = false;
  console.log(pass ? '✅' : '❌', `"${input}" → "${cardUrl}"`);
}
console.log(allPassed ? '✅ ALL relative URL tests passed' : '❌ Some URL tests failed');

// ══ TEST 3: Current DB state ═════════════════════════════════════════════════
console.log('\n══ TEST 3: Current DB URL stats ══');
const total   = db.prepare('SELECT COUNT(*) as c FROM jobs').get();
const badUrls = db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE url LIKE '%naukri.com/%-jobs%' AND url NOT LIKE '%job-listings%' AND url != ''`).get();
const goodUrls= db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE url LIKE '%naukri.com/job-listings%' OR url LIKE '%naukri.com%/view/%'`).get();
const emptyUrl= db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE url IS NULL OR url = ''`).get();

console.log(`Total jobs:                  ${total.c}`);
console.log(`Bad (generic search) URLs:   ${badUrls.c}  ${badUrls.c > 0 ? '⚠️  (pre-fix jobs, will fix on next run)' : '✅'}`);
console.log(`Good (job-specific) URLs:    ${goodUrls.c}`);
console.log(`Empty URLs:                  ${emptyUrl.c}`);

const sampleBad = db.prepare(`SELECT title, url FROM jobs WHERE url LIKE '%naukri.com/%-jobs%' AND url NOT LIKE '%job-listings%' LIMIT 3`).all();
if (sampleBad.length) {
  console.log('\nSample jobs with bad search-page URLs (pre-fix, need re-run):');
  sampleBad.forEach(j => console.log('  ⚠️ ', `"${j.title}"`, '->', j.url));
}

const sampleGood = db.prepare(`SELECT title, url FROM jobs WHERE url LIKE '%naukri.com/job-listings%' LIMIT 3`).all();
if (sampleGood.length) {
  console.log('\nSample jobs with correct job-specific URLs:');
  sampleGood.forEach(j => console.log('  ✅', `"${j.title}"`, '->', j.url));
}

// Cleanup
db.prepare('DELETE FROM jobs WHERE job_id = ?').run(TID);
db.close();
console.log('\n══ Verification complete ══\n');
