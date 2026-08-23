import { getDb } from '../db/client.js';
import { detectAts } from './detect-ats.js';
import { logger } from '../utils/logger.js';
import { getActiveUserId } from '../utils/user-context.js';
import { parseHttpUrl } from '../utils/url.js';

export interface AddUrlResult {
  id: number;
  url: string;
  atsType: string;
  alreadyExisted: boolean;
}

/**
 * Add a job URL to the database for the active user.
 * Duplicate detection is per-user: the same URL can be added by different users.
 */
export function addUrl(url: string, userId = getActiveUserId()): AddUrlResult {
  const trimmedUrl = url.trim();
  if (!parseHttpUrl(trimmedUrl)) {
    throw new Error('Invalid job URL: only absolute http:// or https:// URLs are allowed.');
  }
  url = trimmedUrl;
  const db = getDb();

  // Check for duplicate (per-user: same URL + same user)
  const existing = db.prepare(
    'SELECT id, url, ats_type FROM jobs WHERE url = ? AND user_id = ?',
  ).get(url, userId) as
    | { id: number; url: string; ats_type: string }
    | undefined;

  if (existing) {
    logger.info(`URL already exists for user #${userId} (id=${existing.id}): ${url}`);
    return { id: existing.id, url, atsType: existing.ats_type, alreadyExisted: true };
  }

  const atsType = detectAts(url);

  const stmt = db.prepare(
    'INSERT INTO jobs (url, user_id, ats_type, status, discovered_at, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))',
  );
  const result = stmt.run(url, userId, atsType, 'new');
  const id = Number(result.lastInsertRowid);

  // Log event
  db.prepare(
    "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (?, 'ingest', ?, ?, datetime('now'))",
  ).run(id, `URL added: ${url}`, JSON.stringify({ ats_type: atsType, user_id: userId }));

  logger.info(`Added job (id=${id}, user=${userId}, ats=${atsType}): ${url}`);
  return { id, url, atsType, alreadyExisted: false };
}
