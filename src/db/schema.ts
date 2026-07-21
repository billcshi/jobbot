/**
 * Authoritative JobBot database schema.
 *
 * JobBot deliberately starts from a fresh local database. This file describes
 * the complete current shape; there is no historical migration chain.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_salt  TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_setup_tokens (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  url            TEXT NOT NULL,
  user_id        INTEGER REFERENCES users(id),
  ats_type       TEXT NOT NULL DEFAULT 'generic',
  title          TEXT,
  company        TEXT,
  location       TEXT,
  description    TEXT,
  apply_url      TEXT,
  score          REAL,
  tier           TEXT,
  score_reason   TEXT,
  status         TEXT NOT NULL DEFAULT 'new',
  discovered_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(url, user_id)
);

CREATE TABLE IF NOT EXISTS user_scores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score         REAL,
  tier          TEXT,
  score_reason  TEXT,
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, user_id)
);

CREATE TABLE IF NOT EXISTS profiles (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL DEFAULT 'Primary',
  active_revision_id  INTEGER REFERENCES profile_revisions(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profile_revisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id        INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  revision          INTEGER NOT NULL,
  schema_version    INTEGER NOT NULL DEFAULT 1,
  candidate_json    TEXT NOT NULL CHECK (json_valid(candidate_json)),
  preferences_json  TEXT NOT NULL CHECK (json_valid(preferences_json)),
  source            TEXT NOT NULL,
  source_digest     TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(profile_id, revision),
  UNIQUE(profile_id, source_digest)
);

CREATE TABLE IF NOT EXISTS profile_claims (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id     INTEGER NOT NULL REFERENCES profile_revisions(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  claim_key       TEXT NOT NULL,
  value_json      TEXT NOT NULL CHECK (json_valid(value_json)),
  source_path     TEXT,
  sensitive       INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
  user_confirmed  INTEGER NOT NULL DEFAULT 1 CHECK (user_confirmed IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(revision_id, category, claim_key)
);

CREATE TABLE IF NOT EXISTS job_snapshots (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id                  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id                 INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source_url              TEXT NOT NULL,
  title                   TEXT,
  company                 TEXT,
  location                TEXT,
  description             TEXT NOT NULL,
  apply_url               TEXT,
  content_hash            TEXT NOT NULL,
  extracted_json          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extracted_json)),
  requirements_frozen_at  TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, content_hash)
);

CREATE TABLE IF NOT EXISTS job_requirements (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id        INTEGER NOT NULL REFERENCES job_snapshots(id) ON DELETE CASCADE,
  category           TEXT NOT NULL,
  requirement_key    TEXT NOT NULL,
  requirement_text   TEXT NOT NULL,
  importance         TEXT NOT NULL CHECK (importance IN ('required', 'preferred', 'context')),
  keywords_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(keywords_json)),
  source_spans_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_spans_json)),
  ordinal            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(snapshot_id, category, requirement_text),
  UNIQUE(snapshot_id, requirement_key)
);

CREATE TABLE IF NOT EXISTS resume_drafts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id               INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  profile_revision_id  INTEGER NOT NULL REFERENCES profile_revisions(id),
  job_snapshot_id      INTEGER NOT NULL REFERENCES job_snapshots(id),
  status               TEXT NOT NULL DEFAULT 'planned'
                       CHECK (status IN ('planned', 'generated', 'validated', 'rejected', 'rendered')),
  plan_json            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(plan_json)),
  content_json         TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  prompt_version       TEXT,
  model                TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resume_versions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id               INTEGER NOT NULL REFERENCES jobs(id),
  user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  draft_id             INTEGER REFERENCES resume_drafts(id) ON DELETE SET NULL,
  profile_revision_id  INTEGER REFERENCES profile_revisions(id),
  job_snapshot_id      INTEGER REFERENCES job_snapshots(id),
  version_name         TEXT NOT NULL,
  tex_path             TEXT NOT NULL,
  pdf_path             TEXT,
  content_json         TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  prompt_version       TEXT,
  model                TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, version_name)
);

CREATE TABLE IF NOT EXISTS resume_claims (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_version_id      INTEGER NOT NULL REFERENCES resume_versions(id) ON DELETE CASCADE,
  section                TEXT NOT NULL,
  ordinal                INTEGER NOT NULL,
  rendered_text          TEXT NOT NULL,
  source_claim_ids_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_claim_ids_json)),
  transformation         TEXT NOT NULL DEFAULT 'rewrite'
                         CHECK (transformation IN ('verbatim', 'rewrite', 'combine', 'omit')),
  validation_status      TEXT NOT NULL DEFAULT 'pending'
                         CHECK (validation_status IN ('pending', 'valid', 'invalid', 'needs_review')),
  validation_notes       TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(resume_version_id, section, ordinal)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_draft_id    INTEGER REFERENCES resume_drafts(id) ON DELETE CASCADE,
  resume_version_id  INTEGER REFERENCES resume_versions(id) ON DELETE CASCADE,
  artifact_type      TEXT NOT NULL,
  path               TEXT NOT NULL,
  sha256             TEXT,
  byte_size          INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (resume_draft_id IS NOT NULL OR resume_version_id IS NOT NULL),
  UNIQUE(resume_version_id, artifact_type, path)
);

CREATE TABLE IF NOT EXISTS applications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id             INTEGER NOT NULL REFERENCES jobs(id),
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resume_version_id  INTEGER REFERENCES resume_versions(id),
  status             TEXT NOT NULL DEFAULT 'draft',
  submitted_at       TEXT,
  responded_at       TEXT,
  response_type      TEXT,
  follow_up_at       TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS job_market_data (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  value       TEXT NOT NULL,
  source      TEXT,
  confidence  REAL DEFAULT 0.5,
  sample_size INTEGER DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  trigger        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  input_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
  error_message  TEXT,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT
);

CREATE TABLE IF NOT EXISTS stage_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id  INTEGER NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage            TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status           TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'succeeded', 'failed', 'skipped', 'cancelled')),
  input_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
  output_json      TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  error_message    TEXT,
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at      TEXT,
  UNIQUE(pipeline_run_id, stage, attempt)
);

CREATE TABLE IF NOT EXISTS cover_letter_versions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id               INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resume_version_id    INTEGER NOT NULL REFERENCES resume_versions(id) ON DELETE CASCADE,
  profile_revision_id  INTEGER NOT NULL REFERENCES profile_revisions(id),
  job_snapshot_id      INTEGER NOT NULL REFERENCES job_snapshots(id),
  artifact_id          INTEGER REFERENCES artifacts(id),
  tone                 TEXT NOT NULL,
  content_json         TEXT NOT NULL CHECK (json_valid(content_json)),
  validation_status    TEXT NOT NULL CHECK (validation_status IN ('valid', 'invalid')),
  prompt_version       TEXT NOT NULL,
  model                TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cover_letter_claims (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  cover_letter_version_id  INTEGER NOT NULL REFERENCES cover_letter_versions(id) ON DELETE CASCADE,
  paragraph_ordinal        INTEGER NOT NULL CHECK (paragraph_ordinal >= 0),
  sentence_ordinal         INTEGER NOT NULL CHECK (sentence_ordinal >= 0),
  rendered_text            TEXT NOT NULL,
  source_claim_ids_json    TEXT NOT NULL CHECK (json_valid(source_claim_ids_json)),
  requirement_ids_json     TEXT NOT NULL CHECK (json_valid(requirement_ids_json)),
  validation_status        TEXT NOT NULL CHECK (validation_status IN ('valid', 'invalid', 'needs_review')),
  validation_notes         TEXT NOT NULL,
  UNIQUE(cover_letter_version_id, paragraph_ordinal, sentence_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_setup_expiry ON auth_setup_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_tier ON jobs(tier);
CREATE INDEX IF NOT EXISTS idx_jobs_url ON jobs(url);
CREATE INDEX IF NOT EXISTS idx_user_scores_job ON user_scores(job_id);
CREATE INDEX IF NOT EXISTS idx_user_scores_user ON user_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_profile_revisions_profile ON profile_revisions(profile_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_profile_claims_revision ON profile_claims(revision_id);
CREATE INDEX IF NOT EXISTS idx_job_snapshots_job ON job_snapshots(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_requirements_snapshot ON job_requirements(snapshot_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_resume_drafts_job ON resume_drafts(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resume_claims_version ON resume_claims(resume_version_id, section, ordinal);
CREATE INDEX IF NOT EXISTS idx_artifacts_version ON artifacts(resume_version_id);
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_user ON applications(user_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_market_key ON job_market_data(key);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_job ON pipeline_runs(job_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_active_job_user
  ON pipeline_runs(job_id, user_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_stage_runs_pipeline ON stage_runs(pipeline_run_id, id);
CREATE INDEX IF NOT EXISTS idx_cover_letter_version_resume
  ON cover_letter_versions(resume_version_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_cover_letter_claims_version
  ON cover_letter_claims(cover_letter_version_id, paragraph_ordinal, sentence_ordinal);
`;
