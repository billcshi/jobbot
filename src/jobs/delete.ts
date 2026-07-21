import { getDb } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { getActiveUserId } from '../utils/user-context.js';

export interface DeleteResult {
  deleted: number;
  jobs: { id: number; title: string | null; company: string | null }[];
}

/**
 * Delete a single job by ID. Related rows in resume_versions and
 * applications are cascade-deleted by SQLite foreign keys.
 */
export function deleteJob(id: number, userId = getActiveUserId()): DeleteResult {
  const db = getDb();

  const job = db.prepare(
    'SELECT id, title, company FROM jobs WHERE id = ? AND user_id = ?',
  ).get(id, userId) as { id: number; title: string | null; company: string | null } | undefined;

  if (!job) {
    throw new Error(`Job not found: id=${id}`);
  }

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM applications WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM resume_versions WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM events WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?').run(id, userId);
    // Keep a non-identifying audit record after the job row is gone.
    db.prepare(
      "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (NULL, 'delete', ?, ?, datetime('now'))",
    ).run(`Deleted job #${id}: "${job.title || 'Untitled'}" at ${job.company || 'Unknown'}`, JSON.stringify({ userId }));
  });
  remove();

  logger.info(`Deleted job #${id}: "${job.title || 'Untitled'}" at ${job.company || 'Unknown'}`);
  return { deleted: 1, jobs: [job] };
}

/**
 * Delete all jobs matching a given tier. Requires confirmation unless forced.
 */
export function deleteByTier(tier: string, userId = getActiveUserId()): DeleteResult {
  const db = getDb();

  const jobs = db.prepare(
    'SELECT id, title, company FROM jobs WHERE tier = ? AND user_id = ? ORDER BY id',
  ).all(tier.toUpperCase(), userId) as { id: number; title: string | null; company: string | null }[];

  if (jobs.length === 0) {
    logger.info(`No jobs found with tier ${tier.toUpperCase()}`);
    return { deleted: 0, jobs: [] };
  }

  const ids = jobs.map((j) => j.id);

  const placeholders = ids.map(() => '?').join(',');
  db.transaction(() => {
    db.prepare(`DELETE FROM applications WHERE job_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM resume_versions WHERE job_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM events WHERE job_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders}) AND user_id = ?`).run(...ids, userId);
    db.prepare(
      "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (NULL, 'delete_batch', ?, ?, datetime('now'))",
    ).run(`Deleted ${jobs.length} job(s) with tier ${tier.toUpperCase()}`, JSON.stringify({ userId, ids }));
  })();

  logger.info(`Deleted ${jobs.length} job(s) with tier ${tier.toUpperCase()}`);
  return { deleted: jobs.length, jobs };
}

/**
 * Delete all jobs matching a given status. Requires confirmation unless forced.
 */
export function deleteByStatus(status: string, userId = getActiveUserId()): DeleteResult {
  const db = getDb();

  const jobs = db.prepare(
    'SELECT id, title, company FROM jobs WHERE status = ? AND user_id = ? ORDER BY id',
  ).all(status, userId) as { id: number; title: string | null; company: string | null }[];

  if (jobs.length === 0) {
    logger.info(`No jobs found with status "${status}"`);
    return { deleted: 0, jobs: [] };
  }

  const ids = jobs.map((j) => j.id);

  const placeholders = ids.map(() => '?').join(',');
  db.transaction(() => {
    db.prepare(`DELETE FROM applications WHERE job_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM resume_versions WHERE job_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM events WHERE job_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders}) AND user_id = ?`).run(...ids, userId);
    db.prepare(
      "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (NULL, 'delete_batch', ?, ?, datetime('now'))",
    ).run(`Deleted ${jobs.length} job(s) with status ${status}`, JSON.stringify({ userId, ids }));
  })();

  logger.info(`Deleted ${jobs.length} job(s) with status "${status}"`);
  return { deleted: jobs.length, jobs };
}
