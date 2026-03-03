'use strict';
/**
 * parse_logs_update_urls.js
 * Parses all autoapply log files to extract job_id → URL mappings and updates the database.
 *
 * URL sources in logs:
 *  1. "External tab opened: <url>" – the external company site URL
 *  2. "[ExtApply] External site: <type> | <url>" – also external URL
 *  3. The job_id appears in "Retry N/3 for <job_id>" and "Processing ... <job_id>:" messages
 *     or "No apply button found for <job_id>"
 *
 * Strategy: scan lines sequentially, track the last-seen job_id, and when we see a URL log,
 * associate it with that job_id.
 */

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const LOG_DIR = path.join(process.cwd(), 'logs');
const DB_PATH = path.join(process.cwd(), 'data', 'autoapply.db');

const db = new Database(DB_PATH);

// Get all jobs that have empty URLs
const emptyUrlJobs = db.prepare(`SELECT job_id, title, company FROM jobs WHERE url IS NULL OR url = ''`).all();
console.log(`Jobs with empty URLs in DB: ${emptyUrlJobs.length}`);

// Build a Set of job_ids that need URLs
const needsUrl = new Set(emptyUrlJobs.map(j => j.job_id));

// Map: job_id → URL recovered from logs
const recovered = new Map();

// Parse all log files
const logFiles = fs.readdirSync(LOG_DIR)
  .filter(f => f.startsWith('autoapply-') && f.endsWith('.log'))
  .sort(); // chronological

console.log(`\nParsing log files: ${logFiles.join(', ')}`);

for (const logFile of logFiles) {
  const logPath = path.join(LOG_DIR, logFile);
  const lines = fs.readFileSync(logPath, 'utf8').split('\n');

  let lastJobId = null;

  for (const line of lines) {
    const text = line.replace(/\r/, '');

    // ── Detect job_id from multiple patterns ───────────────────────────────
    // Pattern 1: "Retry N/3 for <job_id>"
    let m = text.match(/Retry \d\/\d for ([A-Za-z0-9_]+)/);
    if (m) lastJobId = m[1];

    // Pattern 2: "Processing ... <job_id>: Processing ..."
    m = text.match(/\[Worker\] Job ([A-Za-z0-9_]+): Processing/);
    if (m) lastJobId = m[1];

    // Pattern 3: "No apply button found for <job_id>"
    m = text.match(/No apply button found for ([A-Za-z0-9_]+)/);
    if (m) lastJobId = m[1];

    // Pattern 4: "No Easy Apply button found for <job_id>"
    m = text.match(/No Easy Apply button found for ([A-Za-z0-9_]+)/);
    if (m) lastJobId = m[1];

    // Pattern 5: Error "jobId":"<job_id>"
    m = text.match(/"jobId"\s*:\s*"([A-Za-z0-9_]+)"/);
    if (m) lastJobId = m[1];

    // ── Detect URLs ────────────────────────────────────────────────────────
    // Pattern A: "External tab opened: <url> – attempting to apply"
    m = text.match(/External tab opened:\s*(https?:\/\/\S+?)\s*[–-]/);
    if (m && lastJobId) {
      const url = m[1].trim();
      // Only store if this job needs a URL and we haven't found one yet
      if (needsUrl.has(lastJobId) && !recovered.has(lastJobId)) {
        recovered.set(lastJobId, url);
        console.log(`  ✅ [${logFile}] ${lastJobId} → ${url}`);
      }
    }

    // Pattern B: "[ExtApply] External site: <type> | <url>"
    m = text.match(/\[ExtApply\] External site:\s*\S+\s*\|\s*(https?:\/\/\S+)/);
    if (m && lastJobId) {
      const url = m[1].trim();
      if (needsUrl.has(lastJobId) && !recovered.has(lastJobId)) {
        recovered.set(lastJobId, url);
        console.log(`  ✅ [${logFile}] ${lastJobId} → ${url} (from ExtApply)`);
      }
    }

    // Pattern C: "[ExtApply] Form step 1 – URL: <url>"
    m = text.match(/\[ExtApply\] Form step 1 – URL:\s*(https?:\/\/\S+)/);
    if (m && lastJobId) {
      const url = m[1].trim();
      if (needsUrl.has(lastJobId) && !recovered.has(lastJobId)) {
        recovered.set(lastJobId, url);
        console.log(`  ✅ [${logFile}] ${lastJobId} → ${url} (from ExtApply form step)`);
      }
    }

    // Pattern D: "[Worker] Job page URL: <url> (job_id: <id>)" — new log line added in fix
    m = text.match(/\[Worker\] Job page URL:\s*(https?:\/\/\S+)\s*\(job_id:\s*([A-Za-z0-9_]+)\)/);
    if (m) {
      const url   = m[1].trim();
      const jobId = m[2].trim();
      if (needsUrl.has(jobId) && !recovered.has(jobId)) {
        recovered.set(jobId, url);
        console.log(`  ✅ [${logFile}] ${jobId} → ${url} (from job page URL log)`);
      }
    }
  }
}

console.log(`\nRecovered URLs from logs: ${recovered.size}`);

// ── Update the database ────────────────────────────────────────────────────
if (recovered.size > 0) {
  const updateStmt = db.prepare(`UPDATE jobs SET url = ? WHERE job_id = ? AND (url IS NULL OR url = '')`);
  let updated = 0;
  for (const [jobId, url] of recovered) {
    const result = updateStmt.run(url, jobId);
    if (result.changes > 0) updated++;
  }
  console.log(`✅ Updated ${updated} job URLs in the database`);
} else {
  console.log('⚠️  No URL→job_id matches found in logs');
}

// ── Final DB stats ──────────────────────────────────────────────────────────
const stats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN url IS NULL OR url = '' THEN 1 ELSE 0 END) as empty,
    SUM(CASE WHEN url LIKE '%naukri.com/job-listings%' OR url LIKE '%naukri.com%/view/%' THEN 1 ELSE 0 END) as naukri_specific,
    SUM(CASE WHEN url NOT LIKE '%naukri.com%' AND url != '' AND url IS NOT NULL THEN 1 ELSE 0 END) as external
  FROM jobs
`).get();

console.log('\n══ Final DB Stats ══');
console.log(`Total jobs:           ${stats.total}`);
console.log(`Still empty URLs:     ${stats.empty}`);
console.log(`Naukri job-page URLs: ${stats.naukri_specific}`);
console.log(`External URLs:        ${stats.external}`);

db.close();
console.log('\n✅ Done');
