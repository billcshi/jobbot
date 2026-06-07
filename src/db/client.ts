import Database from 'better-sqlite3';
import { DB_PATH } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

let db: Database.Database | null = null;

/** Return the singleton database connection. */
export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.debug(`Connected to SQLite at ${DB_PATH}`);
  }
  return db;
}

/** Close the database connection (for graceful shutdown). */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
