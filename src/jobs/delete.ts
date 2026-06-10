import { getDb } from '../db/client.js';
import { logger } from '../utils/logger.js';

export interface DeleteResult {
  deleted: number;
  jobs: { id: number; title: string | null; company: string | null }[];
}

/**
 * Delete a single job by ID. Related rows in resume_versions and
 * applications are cascade-deleted by SQLite foreign keys.
 */
export function deleteJob(id: number): DeleteResult {
  const db = getDb();

  const job = db.prepare(
    'SELECT id, title, company FROM jobs WHERE id = ?',
  ).get(id) as { id: number; title: string | null; company: string | null } | undefined;

  if (!job) {
    throw new Error(`Job not found: id=${id}`);
  }

  // Log deletion event before removing job data
  db.prepare(
    "INSERT INTO events (job_id, event_type, description, created_at) VALUES (?, 'delete', ?, datetime('now'))",
  ).run(id, `Job #${id} deleted: "${job.title || 'Untitled'}" at ${job.company || 'Unknown'}`);

  // Cascade: delete related rows (must delete FK children before parent)
  db.prepare('DELETE FROM applications WHERE job_id = ?').run(id);
  db.prepare('DELETE FROM resume_versions WHERE job_id = ?').run(id);
  db.prepare('DELETE FROM events WHERE job_id = ?').run(id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);

  logger.info(`Deleted job #${id}: "${job.title || 'Untitled'}" at ${job.company || 'Unknown'}`);
  return { deleted: 1, jobs: [job] };
}

/**
 * Delete all jobs matching a given tier. Requires confirmation unless forced.
 */
export function deleteByTier(tier: string): DeleteResult {
  const db = getDb();

  const jobs = db.prepare(
    'SELECT id, title, company FROM jobs WHERE tier = ? ORDER BY id',
  ).all(tier.toUpperCase()) as { id: number; title: string | null; company: string | null }[];

  if (jobs.length === 0) {
    logger.info(`No jobs found with tier ${tier.toUpperCase()}`);
    return { deleted: 0, jobs: [] };
  }

  const ids = jobs.map((j) => j.id);

  db.prepare(
    `DELETE FROM applications WHERE job_id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);
  db.prepare(
    `DELETE FROM resume_versions WHERE job_id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);
  db.prepare(
    `DELETE FROM events WHERE job_id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);
  db.prepare(
    `DELETE FROM jobs WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);

  logger.info(`Deleted ${jobs.length} job(s) with tier ${tier.toUpperCase()}`);
  return { deleted: jobs.length, jobs };
}

/**
 * Delete all jobs matching a given status. Requires confirmation unless forced.
 */
export function deleteByStatus(status: string): DeleteResult {
  const db = getDb();

  const jobs = db.prepare(
    'SELECT id, title, company FROM jobs WHERE status = ? ORDER BY id',
  ).all(status) as { id: number; title: string | null; company: string | null }[];

  if (jobs.length === 0) {
    logger.info(`No jobs found with status "${status}"`);
    return { deleted: 0, jobs: [] };
  }

  const ids = jobs.map((j) => j.id);

  db.prepare(
    `DELETE FROM applications WHERE job_id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);
  db.prepare(
    `DELETE FROM resume_versions WHERE job_id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);
  db.prepare(
    `DELETE FROM events WHERE job_id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);
  db.prepare(
    `DELETE FROM jobs WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);

  logger.info(`Deleted ${jobs.length} job(s) with status "${status}"`);
  return { deleted: jobs.length, jobs };
}
