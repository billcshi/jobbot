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
}
