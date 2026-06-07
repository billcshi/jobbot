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
  logger.info(`Database initialized at ${DB_PATH}`);
}
