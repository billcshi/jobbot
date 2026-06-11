/** SQL statements to create tables if they don't exist. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT NOT NULL,
  user_id         INTEGER REFERENCES users(id),
  ats_type        TEXT NOT NULL DEFAULT 'generic',
  title           TEXT,
  company         TEXT,
  location        TEXT,
  description     TEXT,
  apply_url       TEXT,
  score           REAL,
  tier            TEXT,
  score_reason    TEXT,
  status          TEXT NOT NULL DEFAULT 'new',
  discovered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(url, user_id)
);

-- v0.6: Multi-user support. Jobs are per-user (each user discovers/adds their own pool).
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-user job scores. A user can have at most one score per job.
-- score/tier are NULL for archived-only rows (no score, just hidden).
CREATE TABLE IF NOT EXISTS user_scores (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score           REAL,
  tier            TEXT,
  score_reason    TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, user_id)
);

CREATE TABLE IF NOT EXISTS resume_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER NOT NULL REFERENCES jobs(id),
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  version_name    TEXT NOT NULL,
  tex_path        TEXT NOT NULL,
  pdf_path        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, version_name)
);

-- v0.6: Application lifecycle tracking.
-- Status flow: draft → submitted → replied → interview → offer → accepted/rejected
CREATE TABLE IF NOT EXISTS applications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id              INTEGER NOT NULL REFERENCES jobs(id),
  user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resume_version_id   INTEGER REFERENCES resume_versions(id),
  status              TEXT NOT NULL DEFAULT 'draft',
  submitted_at        TEXT,
  responded_at        TEXT,
  response_type       TEXT,
  follow_up_at        TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER REFERENCES jobs(id),
  application_id  INTEGER REFERENCES applications(id),
  event_type      TEXT NOT NULL,
  description     TEXT,
  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Self-evolving market data: salary ranges, common requirements,
-- and other insights learned from real job postings over time.
CREATE TABLE IF NOT EXISTS job_market_data (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT NOT NULL UNIQUE,
  value           TEXT NOT NULL,
  source          TEXT,
  confidence      REAL DEFAULT 0.5,
  sample_size     INTEGER DEFAULT 1,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_tier ON jobs(tier);
CREATE INDEX IF NOT EXISTS idx_jobs_url ON jobs(url);
CREATE INDEX IF NOT EXISTS idx_market_key ON job_market_data(key);
-- v0.6: Per-user profile storage (candidate, preferences, answers as YAML text).
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  candidate   TEXT NOT NULL DEFAULT '',
  preferences TEXT NOT NULL DEFAULT '',
  answers     TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- New-column indexes are created in the v0.6 migration (applyMigrations)
-- because the columns may not exist yet when SCHEMA_SQL runs on an existing DB.
`;
