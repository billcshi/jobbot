import { getDb } from '../db/client.js';
import { scoreJobWithLLM } from './scorers/llm.js';
import { logger } from '../utils/logger.js';
import { getActiveUserId } from '../utils/user-context.js';

// ----- preference types -----------------------------------------------------

export interface Preferences {
  preferred_titles: string[];
  preferred_locations: {
    remote: boolean;
    cities: string[];
  };
  preferred_companies: string[];
  preferred_industries: string[];
  deal_breakers: {
    description: string;
    keywords: string[];
  };
  weights: Record<string, number>;
  tiers: Record<string, number>;
}

export interface ScoreResult {
  score: number;
  tier: string;
  reason: string;
}

/** Row shape as read from the jobs table. */
interface JobRow {
  id: number;
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
}

// ----- deterministic fallback -----------------------------------------------

function deterministicScore(job: JobRow): ScoreResult {
  // Minimal fallback for placeholder jobs (no description)
  if (!job.description && !job.title) {
    return { score: 0, tier: 'D', reason: 'No job data extracted yet' };
  }
  if (!job.description) {
    // Has a title but no description (unusual). Give neutral score.
    return { score: 0.5, tier: 'C', reason: 'Partial data — extract first for full scoring' };
  }
  return { score: 0.5, tier: 'C', reason: 'Pending LLM scoring' };
}

// ----- batch scoring --------------------------------------------------------

export interface ScoreAllResult {
  scored: number;
  skipped: number;
}

/**
 * Score all jobs using DeepSeek LLM.
 * Jobs with descriptions get full LLM evaluation.
 * Placeholder jobs (no description) get a bare-minimum fallback score.
 *
 * v0.6: Scores are written to user_scores (per-user). The jobs.score/jobs.tier
 * columns are also updated for backward compatibility.
 */
export async function scoreAll(): Promise<ScoreAllResult> {
  const db = getDb();
  const userId = getActiveUserId();

  const jobs = db.prepare(
    "SELECT j.id, j.title, j.company, j.location, j.description FROM jobs j WHERE j.user_id = ? AND j.status != ? AND NOT EXISTS (SELECT 1 FROM user_scores us WHERE us.job_id = j.id AND us.user_id = ?)",
  ).all(userId, 'archived', userId) as JobRow[];

  if (jobs.length === 0) {
    logger.info('No jobs to score.');
    return { scored: 0, skipped: 0 };
  }

  const updateJobsTable = db.prepare(
    "UPDATE jobs SET score = ?, tier = ?, score_reason = ?, status = 'scored', updated_at = datetime('now') WHERE id = ?",
  );
  const upsertUserScore = db.prepare(
    "INSERT INTO user_scores (job_id, user_id, score, tier, score_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now')) ON CONFLICT(job_id, user_id) DO UPDATE SET score = excluded.score, tier = excluded.tier, score_reason = excluded.score_reason, updated_at = datetime('now')",
  );
  const updatePlaceholder = db.prepare(
    "UPDATE jobs SET score = ?, tier = ?, score_reason = ?, updated_at = datetime('now') WHERE id = ?",
  );

  let scored = 0;
  let skipped = 0;

  for (const job of jobs) {
    // Skip placeholder jobs (no title = not extracted yet)
    if (!job.title) {
      const result = deterministicScore(job);
      updatePlaceholder.run(result.score, result.tier, result.reason, job.id);
      skipped++;
      continue;
    }

    try {
      const result = await scoreJobWithLLM(job);
      // Write to jobs table (backward compat)
      updateJobsTable.run(result.score, result.tier, result.reason, job.id);
      // Write to user_scores (per-user)
      upsertUserScore.run(job.id, userId, result.score, result.tier, result.reason);
      // Log event
      db.prepare(
        "INSERT INTO events (job_id, event_type, description, metadata, created_at) VALUES (?, 'score', ?, ?, datetime('now'))",
      ).run(job.id, `${result.tier} (${result.score.toFixed(2)})`, JSON.stringify({ score: result.score, tier: result.tier, user_id: userId, reason: result.reason.slice(0, 200) }));
      scored++;
      logger.debug(`Job ${job.id}: ${result.tier} (${result.score}) — ${result.reason.slice(0, 80)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`LLM scoring failed for job ${job.id}: ${msg}`);
      const fallback = deterministicScore(job);
      updateJobsTable.run(fallback.score, fallback.tier, fallback.reason, job.id);
      upsertUserScore.run(job.id, userId, fallback.score, fallback.tier, fallback.reason);
      skipped++;
    }
  }

  logger.info(`Scored ${scored} job(s) via LLM, ${skipped} skipped/fallback.`);
  return { scored, skipped };
}
