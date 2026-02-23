'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const DB_PATH = path.join(process.cwd(), 'data', 'autoapply.db');
const SQL_INIT_PATH = path.join(process.cwd(), 'config', 'sql', 'init.sql');

let db;

function getDb() {
  if (db) return db;

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run base migrations
  const initSql = fs.readFileSync(SQL_INIT_PATH, 'utf8');
  db.exec(initSql);

  // Migration: drop old screenshots table that has a restrictive CHECK on stage
  // (replaces it with a version that accepts any stage name)
  try {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='screenshots'").get();
    if (tableInfo && tableInfo.sql && tableInfo.sql.includes('CHECK')) {
      logger.info('Migrating screenshots table to remove stage CHECK constraint...');
      db.exec(`
        ALTER TABLE screenshots RENAME TO screenshots_old;
        CREATE TABLE screenshots (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id      TEXT,
          stage       TEXT,
          file_path   TEXT,
          created_at  TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (job_id) REFERENCES jobs(job_id)
        );
        INSERT INTO screenshots SELECT * FROM screenshots_old;
        DROP TABLE screenshots_old;
        CREATE INDEX IF NOT EXISTS idx_screenshots_job_id ON screenshots(job_id);
      `);
      logger.info('screenshots table migration complete');
    }
  } catch (err) {
    logger.warn('screenshots migration skipped or failed', { err: err.message });
  }

  logger.info('Database initialized', { path: DB_PATH });
  return db;
}


// ---------- Job operations ----------

function upsertJob(jobData) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO jobs (job_id, title, company, location, url, description, decision, score, reason, apply_status)
    VALUES (@job_id, @title, @company, @location, @url, @description, @decision, @score, @reason, @apply_status)
    ON CONFLICT(job_id) DO UPDATE SET
      decision     = excluded.decision,
      score        = excluded.score,
      reason       = excluded.reason,
      apply_status = excluded.apply_status
  `);
  return stmt.run(jobData);
}

function updateJobApplyStatus(jobId, status, errorMessage = null, appliedAt = null) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE jobs SET
      apply_status  = @status,
      error_message = @errorMessage,
      applied_at    = @appliedAt,
      retry_count   = retry_count + 1
    WHERE job_id = @jobId
  `);
  return stmt.run({ jobId, status, errorMessage, appliedAt: appliedAt || new Date().toISOString() });
}

function getJob(jobId) {
  const db = getDb();
  return db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);
}

function getAppliedJobs(limit = 100) {
  const db = getDb();
  return db.prepare(`
    SELECT j.*, GROUP_CONCAT(s.file_path) as screenshot_paths
    FROM jobs j
    LEFT JOIN screenshots s ON j.job_id = s.job_id
    WHERE j.decision = 'APPLY'
    GROUP BY j.id
    ORDER BY j.created_at DESC
    LIMIT ?
  `).all(limit);
}

function getAllJobs(limit = 200) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

function getStats() {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) as total_scanned,
      SUM(CASE WHEN decision = 'APPLY' THEN 1 ELSE 0 END) as total_applied,
      SUM(CASE WHEN decision = 'SKIP' THEN 1 ELSE 0 END) as total_skipped,
      SUM(CASE WHEN decision = 'ERROR' THEN 1 ELSE 0 END) as total_errors,
      SUM(CASE WHEN apply_status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN apply_status = 'failed' THEN 1 ELSE 0 END) as fail_count
    FROM jobs
  `).get();
  return row;
}

// ---------- Screenshot operations ----------

function saveScreenshot(jobId, stage, filePath) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO screenshots (job_id, stage, file_path) VALUES (?, ?, ?)
  `);
  return stmt.run(jobId, stage, filePath);
}

function getScreenshotsForJob(jobId) {
  const db = getDb();
  return db.prepare('SELECT * FROM screenshots WHERE job_id = ? ORDER BY created_at').all(jobId);
}

// ---------- Learning list operations ----------

/**
 * Record a question the AI could not answer confidently.
 * If an identical question already exists, increment asked_count instead.
 */
function recordUnknownQuestion(question, fieldType = 'text', options = [], sourceJobId = null) {
  const db = getDb();
  const existing = db.prepare(
    `SELECT id, asked_count FROM learning_questions WHERE question = ? COLLATE NOCASE LIMIT 1`
  ).get(question.trim());
  if (existing) {
    db.prepare(`UPDATE learning_questions SET asked_count = asked_count + 1, updated_at = datetime('now') WHERE id = ?`)
      .run(existing.id);
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO learning_questions (question, field_type, options, source_job)
    VALUES (?, ?, ?, ?)
  `).run(question.trim(), fieldType, JSON.stringify(options), sourceJobId);
  return result.lastInsertRowid;
}

/**
 * Find a previously answered question that is similar to the given question.
 * Returns the row (including `answer`) or undefined.
 */
function findSimilarQuestion(question) {
  const db = getDb();
  const words = question.trim().split(/\s+/).filter(w => w.length > 3);
  if (!words.length) return undefined;
  // Build LIKE conditions for key words
  const conditions = words.map(() => `question LIKE ?`).join(' OR ');
  const params = words.map(w => `%${w}%`);
  return db.prepare(
    `SELECT * FROM learning_questions WHERE answered = 1 AND (${conditions}) ORDER BY asked_count DESC LIMIT 1`
  ).get(...params);
}

/**
 * Retrieve all learning list rows for the dashboard.
 */
function getLearningQuestions(limit = 200) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM learning_questions ORDER BY answered ASC, asked_count DESC LIMIT ?`
  ).all(limit);
}

/**
 * Save an answer for a learning list entry.
 * Only marks `answered = 1` when a non-empty answer is provided.
 * Passing an empty string resets the row back to pending (answered = 0).
 */
function updateLearningAnswer(id, answer) {
  const db = getDb();
  const isAnswered = (typeof answer === 'string' && answer.trim().length > 0) ? 1 : 0;
  return db.prepare(
    `UPDATE learning_questions SET answer = ?, answered = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(answer, isAnswered, id);
}

/**
 * Reset a learning list entry back to unanswered / pending state.
 */
function resetLearningAnswer(id) {
  const db = getDb();
  return db.prepare(
    `UPDATE learning_questions SET answer = '', answered = 0, updated_at = datetime('now') WHERE id = ?`
  ).run(id);
}

// ---------- CSV export ----------

function exportAppliedJobsCsv() {
  const jobs = getAppliedJobs(1000);
  const header = ['job_id', 'title', 'company', 'location', 'url', 'score', 'reason', 'apply_status', 'created_at', 'applied_at'];
  const rows = jobs.map(j =>
    header.map(h => `"${(j[h] || '').toString().replace(/"/g, '""')}"`).join(',')
  );
  return [header.join(','), ...rows].join('\n');
}

module.exports = {
  getDb,
  upsertJob,
  updateJobApplyStatus,
  getJob,
  getAppliedJobs,
  getAllJobs,
  getStats,
  saveScreenshot,
  getScreenshotsForJob,
  recordUnknownQuestion,
  findSimilarQuestion,
  getLearningQuestions,
  updateLearningAnswer,
  resetLearningAnswer,
  exportAppliedJobsCsv,
};

