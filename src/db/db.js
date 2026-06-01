'use strict';

/**
 * AutoApply — Database Layer
 * Uses better-sqlite3 (synchronous).
 *
 * Provides two interfaces:
 *  1. Class-based (new Database(path)) — as requested by spec
 *  2. Legacy function exports — for backward compatibility with existing
 *     worker.js, dashboard/server.js, and other callers.
 *
 * A singleton instance is exported at the bottom:
 *   module.exports = new Database('./data/autoapply.db')
 *
 * Callers that used the old function-export style can migrate to:
 *   const db = require('./db');
 *   db.upsertJob(...)   // still works — bound methods
 */

const BetterSqlite = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const SQL_INIT_PATH = path.join(process.cwd(), 'config', 'sql', 'init.sql');

// ─────────────────────────────────────────────────────────────────────────────
// Database Class
// ─────────────────────────────────────────────────────────────────────────────

class Database {
  /**
   * @param {string} dbPath - Path to the SQLite file (e.g. './data/autoapply.db')
   */
  constructor(dbPath) {
    const absPath = path.isAbsolute(dbPath)
      ? dbPath
      : path.join(process.cwd(), dbPath);

    // Ensure the data directory exists
    const dataDir = path.dirname(absPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this._db = new BetterSqlite(absPath);
    logger.info(`[DB] Opened: ${absPath}`);

    // Enable WAL mode for concurrent readers
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');

    // Run migrations before full schema init
    this._runMigrations();

    // Init schema from SQL file
    const initSql = fs.readFileSync(SQL_INIT_PATH, 'utf8');
    this._db.exec(initSql);

    logger.info('[DB] Schema initialised');
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  _runMigrations() {
    // migration 1: add answer_key column to learning_questions if it exists without it
    try {
      const tableInfo = this._db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_questions'")
        .get();
      if (tableInfo) {
        const cols = this._db.prepare('PRAGMA table_info(learning_questions)').all();
        if (!cols.find(c => c.name === 'answer_key')) {
          this._db.exec(`ALTER TABLE learning_questions ADD COLUMN answer_key TEXT`);
          this._db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lq_answer_key ON learning_questions(answer_key)`);
          logger.info('[DB] Migration: added answer_key column to learning_questions');
        }
      }
    } catch (err) {
      logger.warn('[DB] answer_key migration skipped', { err: err.message });
    }

    // migration 2: drop screenshots table with restrictive CHECK constraint
    try {
      const row = this._db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='screenshots'")
        .get();
      if (row && row.sql && row.sql.includes('CHECK')) {
        logger.info('[DB] Migrating screenshots table to remove stage CHECK constraint');
        this._db.exec(`
          ALTER TABLE screenshots RENAME TO screenshots_old;
          CREATE TABLE screenshots (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id     TEXT,
            stage      TEXT,
            file_path  TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (job_id) REFERENCES jobs(job_id)
          );
          INSERT INTO screenshots SELECT * FROM screenshots_old;
          DROP TABLE screenshots_old;
          CREATE INDEX IF NOT EXISTS idx_screenshots_job_id ON screenshots(job_id);
        `);
        logger.info('[DB] screenshots table migration complete');
      }
    } catch (err) {
      logger.warn('[DB] screenshots migration skipped', { err: err.message });
    }
  }

  // ─── APPLICATIONS TABLE (multi-portal unified apply log) ────────────────────

  /**
   * Check if a job has already been applied to.
   * @param {string} jobId
   * @param {string} portal
   * @returns {boolean}
   */
  isAlreadyApplied(jobId, portal) {
    const row = this._db
      .prepare('SELECT id FROM applications WHERE job_id = ? AND portal = ?')
      .get(jobId, portal);
    return !!row;
  }

  /**
   * Save an application record. Uses INSERT OR IGNORE to respect UNIQUE(job_id, portal).
   * @returns {number} - lastInsertRowid (0 if duplicate)
   */
  saveApplication({ jobId, portal, title, company, location, salary, score,
                    status, aiReason, coverLetter, screenshot, applyUrl }) {
    const result = this._db.prepare(`
      INSERT OR IGNORE INTO applications
        (job_id, portal, title, company, location, salary, score,
         status, ai_reason, cover_letter, screenshot, apply_url)
      VALUES
        (@jobId, @portal, @title, @company, @location, @salary, @score,
         @status, @aiReason, @coverLetter, @screenshot, @applyUrl)
    `).run({ jobId, portal, title, company, location, salary,
              score: score || 0, status: status || 'pending',
              aiReason, coverLetter, screenshot, applyUrl });

    if (result.lastInsertRowid) {
      logger.info(`[DB] Application saved: ${title} @ ${company} [${portal}] id=${result.lastInsertRowid}`);
    } else {
      logger.debug(`[DB] Duplicate application skipped: ${jobId}/${portal}`);
    }
    return result.lastInsertRowid;
  }

  /**
   * Update the status of an application row.
   * @param {number} id
   * @param {string} status
   */
  updateStatus(id, status) {
    this._db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(status, id);
  }

  /**
   * Retrieve application records with optional filters.
   * @param {{ limit?: number, portal?: string|null, status?: string|null }} opts
   * @returns {Array<object>}
   */
  getAll({ limit = 200, portal = null, status = null } = {}) {
    let sql = 'SELECT * FROM applications WHERE 1=1';
    const params = [];
    if (portal) { sql += ' AND portal = ?'; params.push(portal); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return this._db.prepare(sql).all(...params);
  }

  /**
   * Aggregate stats across all portals.
   * @returns {{ total: number, applied: number, skipped: number, failed: number, byPortal: object }}
   */
  getStats() {
    const row = this._db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'applied'  THEN 1 ELSE 0 END) AS applied,
        SUM(CASE WHEN status = 'skipped'  THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN status = 'failed'   THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending
      FROM applications
    `).get();

    const byPortalRows = this._db.prepare(`
      SELECT portal, COUNT(*) AS count FROM applications GROUP BY portal
    `).all();

    const byPortal = {};
    for (const r of byPortalRows) byPortal[r.portal] = r.count;

    return {
      total:   row.total   || 0,
      applied: row.applied || 0,
      skipped: row.skipped || 0,
      failed:  row.failed  || 0,
      pending: row.pending || 0,
      byPortal,
    };
  }

  getStatsByPortal() {
    const rows = this._db.prepare(`
      SELECT portal,
        SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) AS applied,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
        COUNT(*) AS total
      FROM applications
      GROUP BY portal
    `).all();
    const result = {};
    for (const r of rows) {
      result[r.portal] = {
        applied: r.applied || 0,
        skipped: r.skipped || 0,
        failed:  r.failed  || 0,
        total:   r.total   || 0,
      };
    }
    return result;
  }

  // ─── JOBS QUEUE TABLE ────────────────────────────────────────────────────────

  /**
   * Add a URL to the queue. Uses INSERT OR IGNORE to avoid duplicates.
   */
  addToQueue({ url, title, company, portal, atsType }) {
    this._db.prepare(`
      INSERT OR IGNORE INTO jobs_queue (url, title, company, portal, ats_type)
      VALUES (@url, @title, @company, @portal, @atsType)
    `).run({ url, title: title || null, company: company || null,
              portal: portal || null, atsType: atsType || null });
  }

  /** @returns {Array<object>} All pending queue entries */
  getQueuePending() {
    return this._db
      .prepare("SELECT * FROM jobs_queue WHERE status = 'pending' ORDER BY added_at ASC")
      .all();
  }

  /**
   * Update the status of a queue entry.
   * @param {number} id
   * @param {string} status  e.g. 'done', 'failed', 'processing'
   */
  updateQueueStatus(id, status) {
    this._db.prepare('UPDATE jobs_queue SET status = ? WHERE id = ?').run(status, id);
  }

  // ─── LEGACY: jobs table (Naukri / original portal) ──────────────────────────
  // These methods are kept for backward compatibility with worker.js / server.js.

  upsertJob(jobData) {
    return this._db.prepare(`
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
    `).run(jobData);
  }

  updateJobApplyStatus(jobId, status, errorMessage = null, appliedAt = null) {
    return this._db.prepare(`
      UPDATE jobs SET
        apply_status  = @status,
        error_message = @errorMessage,
        applied_at    = @appliedAt,
        retry_count   = retry_count + 1
      WHERE job_id = @jobId
    `).run({ jobId, status, errorMessage, appliedAt: appliedAt || new Date().toISOString() });
  }

  getJob(jobId) {
    return this._db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);
  }

  getAppliedJobs(limit = 100) {
    return this._db.prepare(`
      SELECT j.*, GROUP_CONCAT(s.file_path) AS screenshot_paths
      FROM jobs j
      LEFT JOIN screenshots s ON j.job_id = s.job_id
      WHERE j.decision = 'APPLY'
      GROUP BY j.id
      ORDER BY j.created_at DESC
      LIMIT ?
    `).all(limit);
  }

  getAllJobs(limit = 200) {
    return this._db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  getLegacyStats() {
    return this._db.prepare(`
      SELECT
        COUNT(*) AS total_scanned,
        SUM(CASE WHEN decision = 'APPLY'   THEN 1 ELSE 0 END) AS total_applied,
        SUM(CASE WHEN decision = 'SKIP'    THEN 1 ELSE 0 END) AS total_skipped,
        SUM(CASE WHEN decision = 'ERROR'   THEN 1 ELSE 0 END) AS total_errors,
        SUM(CASE WHEN apply_status = 'success' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN apply_status = 'failed'  THEN 1 ELSE 0 END) AS fail_count
      FROM jobs
    `).get();
  }

  // ─── LEGACY: screenshots ────────────────────────────────────────────────────

  saveScreenshot(jobId, stage, filePath) {
    return this._db.prepare(
      'INSERT INTO screenshots (job_id, stage, file_path) VALUES (?, ?, ?)'
    ).run(jobId, stage, filePath);
  }

  getScreenshotsForJob(jobId) {
    return this._db.prepare(
      'SELECT * FROM screenshots WHERE job_id = ? ORDER BY created_at'
    ).all(jobId);
  }

  // ─── LEGACY: learning_questions ─────────────────────────────────────────────

  recordUnknownQuestion(question, fieldType = 'text', options = [], sourceJobId = null) {
    const existing = this._db.prepare(
      'SELECT id, asked_count FROM learning_questions WHERE question = ? COLLATE NOCASE LIMIT 1'
    ).get(question.trim());
    if (existing) {
      this._db.prepare(
        "UPDATE learning_questions SET asked_count = asked_count + 1, updated_at = datetime('now') WHERE id = ?"
      ).run(existing.id);
      return existing.id;
    }
    const result = this._db.prepare(
      'INSERT INTO learning_questions (question, field_type, options, source_job) VALUES (?, ?, ?, ?)'
    ).run(question.trim(), fieldType, JSON.stringify(options), sourceJobId);
    return result.lastInsertRowid;
  }

  findAnswerByQuestion(question) {
    const row = this._db.prepare(
      'SELECT answer FROM learning_questions WHERE question = ? COLLATE NOCASE AND answered = 1 LIMIT 1'
    ).get(question.trim());
    return row ? row.answer : undefined;
  }

  findSimilarQuestion(question) {
    const words = question.trim().split(/\s+/).filter(w => w.length > 3);
    if (!words.length) return undefined;
    const conditions = words.map(() => 'question LIKE ?').join(' OR ');
    const params = words.map(w => `%${w}%`);
    return this._db.prepare(
      `SELECT * FROM learning_questions WHERE answered = 1 AND (${conditions}) ORDER BY asked_count DESC LIMIT 1`
    ).get(...params);
  }

  getLearningQuestions(limit = 200) {
    return this._db.prepare(
      'SELECT * FROM learning_questions ORDER BY answered ASC, asked_count DESC LIMIT ?'
    ).all(limit);
  }

  updateLearningAnswer(id, answer) {
    const isAnswered = (typeof answer === 'string' && answer.trim().length > 0) ? 1 : 0;
    return this._db.prepare(
      "UPDATE learning_questions SET answer = ?, answered = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(answer, isAnswered, id);
  }

  findAnswerByKey(answerKey) {
    const row = this._db.prepare(
      'SELECT answer FROM learning_questions WHERE answer_key = ? AND answered = 1 LIMIT 1'
    ).get(answerKey);
    return row ? row.answer : '';
  }

  getAllAnsweredAsMap() {
    const rows = this._db.prepare(
      'SELECT answer_key, answer FROM learning_questions WHERE answered = 1 AND answer_key IS NOT NULL'
    ).all();
    const map = {};
    for (const r of rows) { if (r.answer_key) map[r.answer_key] = r.answer; }
    return map;
  }

  getAllAnsweringContext(limit = 30) {
    const rows = this._db.prepare(
      'SELECT question, answer FROM learning_questions WHERE answered = 1 ORDER BY updated_at DESC LIMIT ?'
    ).all(limit);
    return rows.map(r => `Question: ${r.question}\nAnswer: ${r.answer}`).join('\n---\n');
  }

  addManualLearningQuestion(question, answer, answerKey = null) {
    return this._db.prepare(`
      INSERT INTO learning_questions (question, answer, answer_key, answered, asked_count, updated_at)
      VALUES (?, ?, ?, 1, 1, datetime('now'))
      ON CONFLICT(answer_key) DO UPDATE SET
        answer = excluded.answer,
        updated_at = excluded.updated_at
      WHERE answer_key IS NOT NULL
    `).run(question, answer, answerKey);
  }

  resetLearningAnswer(id) {
    return this._db.prepare(
      "UPDATE learning_questions SET answer = '', answered = 0, updated_at = datetime('now') WHERE id = ?"
    ).run(id);
  }

  deleteLearningQuestion(id) {
    return this._db.prepare('DELETE FROM learning_questions WHERE id = ?').run(id);
  }

  // ─── CSV export ─────────────────────────────────────────────────────────────

  exportAppliedJobsCsv() {
    const jobs = this.getAppliedJobs(1000);
    const header = ['job_id','title','company','location','url','score','reason','apply_status','created_at','applied_at'];
    const rows = jobs.map(j =>
      header.map(h => `"${(j[h] || '').toString().replace(/"/g, '""')}"`).join(',')
    );
    return [header.join(','), ...rows].join('\n');
  }

  // ─── Raw db access (for advanced callers) ───────────────────────────────────

  /** @returns {import('better-sqlite3').Database} */
  getDb() { return this._db; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────────────────────

const instance = new Database('./data/autoapply.db');

// Backward-compatible function exports so existing callers don't need changes.
instance.getStats_legacy = instance.getLegacyStats.bind(instance);

module.exports = instance;
