'use strict';
// Clear old bad search-page URLs from existing jobs
const Database = require('better-sqlite3');
const db = new Database('data/autoapply.db');

// Count bad URLs before
const before = db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE url LIKE '%naukri.com/%-jobs%' AND url NOT LIKE '%job-listings%' AND url != ''`).get();
console.log(`Bad search-page URLs before cleanup: ${before.c}`);

// Clear them (set to empty string so dashboard shows '–' instead of wrong link)
const result = db.prepare(`UPDATE jobs SET url = '' WHERE url LIKE '%naukri.com/%-jobs%' AND url NOT LIKE '%job-listings%'`).run();
console.log(`✅ Cleared ${result.changes} bad URLs from the database.`);
console.log('  These jobs will get correct URLs when the bot processes them on the next run.');

// Verify
const after = db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE url LIKE '%naukri.com/%-jobs%' AND url NOT LIKE '%job-listings%' AND url != ''`).get();
console.log(`Bad search-page URLs after cleanup: ${after.c}`);
console.log(after.c === 0 ? '✅ All bad URLs cleared!' : `⚠️ ${after.c} still remain`);

db.close();
