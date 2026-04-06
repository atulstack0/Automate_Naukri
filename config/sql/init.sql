-- AutoApply Database Schema
-- =========================================================
-- TABLE: jobs  (original Naukri scraping table)
-- =========================================================
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT UNIQUE,
  title         TEXT,
  company       TEXT,
  location      TEXT,
  url           TEXT,
  description   TEXT,
  decision      TEXT CHECK(decision IN ('APPLY', 'SKIP', 'ERROR', 'PENDING')),
  score         INTEGER DEFAULT 0,
  reason        TEXT,
  apply_status  TEXT CHECK(apply_status IN ('success', 'failed', 'skipped', 'pending', 'retrying')),
  retry_count   INTEGER DEFAULT 0,
  error_message TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  applied_at    TEXT
);

CREATE TABLE IF NOT EXISTS screenshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT,
  stage       TEXT,
  file_path   TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id)
);

CREATE TABLE IF NOT EXISTS run_stats (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date        TEXT DEFAULT (datetime('now')),
  total_scanned   INTEGER DEFAULT 0,
  total_applied   INTEGER DEFAULT 0,
  total_skipped   INTEGER DEFAULT 0,
  total_errors    INTEGER DEFAULT 0,
  total_pages     INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_decision      ON jobs(decision);
CREATE INDEX IF NOT EXISTS idx_jobs_apply_status  ON jobs(apply_status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at    ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_screenshots_job_id ON screenshots(job_id);

-- =========================================================
-- TABLE: learning_questions  (AI Q&A learning list)
-- =========================================================
CREATE TABLE IF NOT EXISTS learning_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question    TEXT NOT NULL,
  field_type  TEXT DEFAULT 'text',
  options     TEXT DEFAULT '[]',
  answer      TEXT DEFAULT '',
  answer_key  TEXT,
  source_job  TEXT,
  asked_count INTEGER DEFAULT 1,
  answered    INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX        IF NOT EXISTS idx_lq_answered   ON learning_questions(answered);
CREATE INDEX        IF NOT EXISTS idx_lq_question   ON learning_questions(question);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lq_answer_key ON learning_questions(answer_key);

-- =========================================================
-- TABLE: applications  (multi-portal unified apply log)
-- =========================================================
CREATE TABLE IF NOT EXISTS applications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL,
  portal       TEXT NOT NULL,
  title        TEXT NOT NULL,
  company      TEXT NOT NULL,
  location     TEXT,
  salary       TEXT,
  score        INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'pending',
  ai_reason    TEXT,
  cover_letter TEXT,
  screenshot   TEXT,
  apply_url    TEXT,
  created_at   DATETIME DEFAULT (datetime('now')),
  UNIQUE(job_id, portal)
);
CREATE INDEX IF NOT EXISTS idx_app_portal ON applications(portal);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status);

-- =========================================================
-- TABLE: jobs_queue  (URLs to visit/apply)
-- =========================================================
CREATE TABLE IF NOT EXISTS jobs_queue (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  url      TEXT UNIQUE NOT NULL,
  title    TEXT,
  company  TEXT,
  portal   TEXT,
  ats_type TEXT,
  status   TEXT DEFAULT 'pending',
  added_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON jobs_queue(status);
