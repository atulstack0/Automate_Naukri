-- AutoApply Database Schema

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
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date    TEXT DEFAULT (datetime('now')),
  total_scanned   INTEGER DEFAULT 0,
  total_applied   INTEGER DEFAULT 0,
  total_skipped   INTEGER DEFAULT 0,
  total_errors    INTEGER DEFAULT 0,
  total_pages     INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_decision ON jobs(decision);
CREATE INDEX IF NOT EXISTS idx_jobs_apply_status ON jobs(apply_status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_screenshots_job_id ON screenshots(job_id);

-- Learning list: questions the AI could not answer confidently
CREATE TABLE IF NOT EXISTS learning_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question    TEXT NOT NULL,
  field_type  TEXT DEFAULT 'text',
  options     TEXT DEFAULT '[]',
  answer      TEXT DEFAULT '',
  source_job  TEXT,
  asked_count INTEGER DEFAULT 1,
  answered    INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lq_answered ON learning_questions(answered);
CREATE INDEX IF NOT EXISTS idx_lq_question ON learning_questions(question);
