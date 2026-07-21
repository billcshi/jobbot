import type Database from 'better-sqlite3';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { getDb } from './client.js';
import { SCHEMA_SQL } from './schema.js';
import { logger } from '../utils/logger.js';
import { DATA_DIR, LOCAL_DIR, LOCAL_EXAMPLE_DIR, DB_PATH } from '../utils/paths.js';

/** Create the gitignored local workspace from the committed template. */
export function ensureLocalDir(): void {
  if (!existsSync(LOCAL_DIR)) {
    logger.info(`Creating local directory from template (${LOCAL_EXAMPLE_DIR})...`);
    cpSync(LOCAL_EXAMPLE_DIR, LOCAL_DIR, { recursive: true });
    logger.info(`Created ${LOCAL_DIR}`);
  }

  const configPath = `${LOCAL_DIR}/config.yaml`;
  const configTemplate = `${LOCAL_EXAMPLE_DIR}/config.yaml`;
  if (!existsSync(configPath) && existsSync(configTemplate)) {
    cpSync(configTemplate, configPath);
    logger.info(`Created ${configPath} from template`);
  }
  mkdirSync(DATA_DIR, { recursive: true });
}

/** Initialize the complete current schema in a fresh local database. */
export function initDb(): void {
  ensureLocalDir();
  const db = getDb();
  db.transaction(() => db.exec(SCHEMA_SQL))();
  reconcileInterruptedRuns(db);
  logger.info(`Database initialized at ${DB_PATH}`);
}

/** Mark work interrupted by a previous process as terminal during startup. */
export function reconcileInterruptedRuns(db: Database.Database): void {
  db.prepare(`
    UPDATE stage_runs
    SET status = 'cancelled',
        error_message = COALESCE(error_message, 'Interrupted by process restart'),
        finished_at = COALESCE(finished_at, datetime('now'))
    WHERE status = 'running'
  `).run();
  db.prepare(`
    UPDATE pipeline_runs
    SET status = 'cancelled',
        error_message = COALESCE(error_message, 'Interrupted by process restart'),
        finished_at = COALESCE(finished_at, datetime('now'))
    WHERE status = 'running'
  `).run();
}
