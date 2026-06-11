import { getDb } from './client.js';
import { SCHEMA_SQL } from './schema.js';
import { logger } from '../utils/logger.js';
import { DATA_DIR, LOCAL_DIR, LOCAL_EXAMPLE_DIR, DB_PATH } from '../utils/paths.js';
import { cpSync, existsSync, mkdirSync } from 'node:fs';

/**
 * Ensure the local/ data directory exists.
 * On first run, copies templates from local.example/ → local/ (skips existing files).
 */
export function ensureLocalDir(): void {
  if (!existsSync(LOCAL_DIR)) {
    logger.info(`Creating local directory from template (${LOCAL_EXAMPLE_DIR})...`);
    cpSync(LOCAL_EXAMPLE_DIR, LOCAL_DIR, { recursive: true });
    logger.info(`Created ${LOCAL_DIR}`);
  }

  // Always ensure config.yaml exists (copy from template if missing)
  const configPath = `${LOCAL_DIR}/config.yaml`;
  const configTemplate = `${LOCAL_EXAMPLE_DIR}/config.yaml`;
  if (!existsSync(configPath) && existsSync(configTemplate)) {
    cpSync(configTemplate, configPath);
    logger.info(`Created ${configPath} from template`);
  }

  // Ensure runtime subdirectories exist (browser-data etc.)
  mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Create/update the SQLite database and all tables.
 * Also ensures the local/ directory structure exists.
 */
export function initDb(): void {
  ensureLocalDir();

  const db = getDb();
  db.exec(SCHEMA_SQL);

  // Migrations: handle schema changes across versions
  applyMigrations(db);

  logger.info(`Database initialized at ${DB_PATH}`);
}

/** Apply any pending schema migrations. */
function applyMigrations(db: ReturnType<typeof getDb>): void {
  // v0.3→v0.4: rename typst_path → tex_path
  const cols = db.prepare('PRAGMA table_info(resume_versions)').all() as { name: string }[];
  const hasTypst = cols.some((c) => c.name === 'typst_path');
  const hasTex = cols.some((c) => c.name === 'tex_path');

  if (hasTypst && !hasTex) {
    logger.info('Migrating: resume_versions.typst_path → tex_path');
    db.exec('ALTER TABLE resume_versions RENAME COLUMN typst_path TO tex_path');
  }

  // v0.5→v0.6: multi-user mode + application tracking
  migrateV06(db);
  // Always ensure user_preferences exists (added after initial v0.6 migration)
  ensureUserPreferencesTable(db);
  // v0.6.1: jobs are per-user
  migrateV061PerUserJobs(db);
}

/**
 * v0.5 → v0.6 migration:
 *  1. Create users table (if not exists — handled by SCHEMA_SQL)
 *  2. Create user_scores table
 *  3. Add user_id to resume_versions
 *  4. Add user_id + response fields to applications
 *  5. Create default user
 *  6. Migrate existing scores to user_scores
 */
function migrateV06(db: ReturnType<typeof getDb>): void {
  // Check if migration already applied: default user exists
  const defaultUser = db.prepare('SELECT id FROM users WHERE name = ?').get('default') as
    | { id: number }
    | undefined;
  // Also check if resume_versions has user_id (double-check)
  const rvCols = db.prepare('PRAGMA table_info(resume_versions)').all() as { name: string }[];
  const hasUserId = rvCols.some((c) => c.name === 'user_id');
  if (defaultUser && hasUserId) return;

  logger.info('Migrating v0.5 → v0.6: multi-user mode...');

  // 1. Create new tables (SCHEMA_SQL uses IF NOT EXISTS so safe to re-run)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL UNIQUE,
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_scores (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id          INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score           REAL NOT NULL,
      tier            TEXT NOT NULL,
      score_reason    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(job_id, user_id)
    );
  `);

  // 2. Add columns to existing tables (SQLite ALTER TABLE is additive-only)
  addColumnIfMissing(db, 'resume_versions', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'applications', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'applications', 'responded_at', 'TEXT');
  addColumnIfMissing(db, 'applications', 'response_type', 'TEXT');

  // 3. Create default user
  const existingUser = db.prepare('SELECT id FROM users WHERE name = ?').get('default') as { id: number } | undefined;
  let defaultUserId: number;
  if (!existingUser) {
    const result = db.prepare(
      "INSERT INTO users (name, active, created_at) VALUES ('default', 1, datetime('now'))",
    ).run();
    defaultUserId = Number(result.lastInsertRowid);
    logger.info('Created default user (id=1)');
  } else {
    defaultUserId = existingUser.id;
  }

  // 4. Migrate existing scores from jobs table to user_scores
  const scoredJobs = db.prepare(
    'SELECT id, score, tier, score_reason FROM jobs WHERE score IS NOT NULL',
  ).all() as { id: number; score: number; tier: string; score_reason: string | null }[];

  if (scoredJobs.length > 0) {
    const insertScore = db.prepare(
      'INSERT OR IGNORE INTO user_scores (job_id, user_id, score, tier, score_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))',
    );
    const migrateMany = db.transaction(() => {
      for (const job of scoredJobs) {
        insertScore.run(job.id, defaultUserId, job.score, job.tier, job.score_reason);
      }
    });
    migrateMany();
    logger.info(`Migrated ${scoredJobs.length} scores to user_scores for default user`);
  }

  // 5. Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_scores_job ON user_scores(job_id);
    CREATE INDEX IF NOT EXISTS idx_user_scores_user ON user_scores(user_id);
    CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id);
    CREATE INDEX IF NOT EXISTS idx_applications_user ON applications(user_id);
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
  `);

  logger.info('v0.6 migration complete');
}

/** Add a column to a table if it doesn't already have one with that name. */
function addColumnIfMissing(
  db: ReturnType<typeof getDb>,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    logger.info(`Added column: ${table}.${column}`);
  }
}

/** v0.6.1: per-user jobs — add user_id to jobs table. */
function migrateV061PerUserJobs(db: ReturnType<typeof getDb>): void {
  addColumnIfMissing(db, 'jobs', 'user_id', 'INTEGER REFERENCES users(id)');

  // Assign existing jobs to the default user
  const orphaned = db.prepare(
    'SELECT COUNT(*) as c FROM jobs WHERE user_id IS NULL',
  ).get() as { c: number };
  if (orphaned.c > 0) {
    const defaultUser = db.prepare('SELECT id FROM users WHERE name = ?').get('default') as
      | { id: number }
      | undefined;
    if (defaultUser) {
      db.prepare('UPDATE jobs SET user_id = ? WHERE user_id IS NULL').run(defaultUser.id);
      logger.info(`Assigned ${orphaned.c} existing jobs to default user`);
    }
  }
}

/** Ensure the user_preferences table exists. Rows are created on first read via ensureRow(). */
function ensureUserPreferencesTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      candidate   TEXT NOT NULL DEFAULT '',
      preferences TEXT NOT NULL DEFAULT '',
      answers     TEXT NOT NULL DEFAULT '',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
