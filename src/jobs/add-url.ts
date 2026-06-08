import { getDb } from '../db/client.js';
import { detectAts } from './detect-ats.js';
import { logger } from '../utils/logger.js';

export interface AddUrlResult {
  id: number;
  url: string;
  atsType: string;
  alreadyExisted: boolean;
}

/**
 * Add a job URL to the database.
 * If the URL already exists the call is a no-op and returns the existing row.
 */
export function addUrl(url: string): AddUrlResult {
  const db = getDb();

  // Check for duplicate
  const existing = db.prepare('SELECT id, url, ats_type FROM jobs WHERE url = ?').get(url) as
    | { id: number; url: string; ats_type: string }
    | undefined;

  if (existing) {
    logger.info(`URL already exists (id=${existing.id}): ${url}`);
    return { id: existing.id, url, atsType: existing.ats_type, alreadyExisted: true };
  }

  const atsType = detectAts(url);

  const stmt = db.prepare(
    'INSERT INTO jobs (url, ats_type, status, discovered_at, updated_at) VALUES (?, ?, ?, datetime(\'now\'), datetime(\'now\'))',
  );
  const result = stmt.run(url, atsType, 'new');
  const id = Number(result.lastInsertRowid);

  // Log event
  db.prepare(
    "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (?, 'ingest', ?, ?, datetime('now'))",
  ).run(id, `URL added: ${url}`, JSON.stringify({ ats_type: atsType }));

  logger.info(`Added job (id=${id}, ats=${atsType}): ${url}`);
  return { id, url, atsType, alreadyExisted: false };
}
