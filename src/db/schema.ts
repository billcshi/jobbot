/** SQL statements to create tables if they don't exist. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT NOT NULL UNIQUE,
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
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resume_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER NOT NULL REFERENCES jobs(id),
  version_name    TEXT NOT NULL,
  tex_path        TEXT NOT NULL,
  pdf_path        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, version_name)
);

CREATE TABLE IF NOT EXISTS applications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id              INTEGER NOT NULL REFERENCES jobs(id),
  resume_version_id   INTEGER REFERENCES resume_versions(id),
  status              TEXT NOT NULL DEFAULT 'draft',
  submitted_at        TEXT,
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
`;
