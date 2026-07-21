import type Database from 'better-sqlite3';
import { PipelineRunRepository, type RunStatus, type StageStatus } from '../../repositories/pipeline-run-repository.js';
import type {
  PipelineJob,
  PipelineRepository,
  PipelineStage,
  ScoreStageResult,
  StageRecord,
} from './types.js';

interface JobRow {
  id: number;
  user_id: number;
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  score: number | null;
  tier: string | null;
  status: string;
}

function toPipelineJob(row: JobRow): PipelineJob {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    company: row.company,
    location: row.location,
    description: row.description,
    score: row.score,
    tier: row.tier,
    status: row.status,
  };
}

const JOB_COLUMNS = 'id, user_id, title, company, location, description, score, tier, status';

/** SQLite adapter for the application pipeline service. */
export class SqlitePipelineRepository implements PipelineRepository {
  private readonly runs: PipelineRunRepository;
  private readonly activeRuns = new Map<string, { runId: number; stageRunId: number; ownsRun: boolean }>();
  private readonly activeJobRuns = new Map<string, number>();

  constructor(private readonly db: Database.Database) {
    this.runs = new PipelineRunRepository(db);
  }

  listPending(userId: number): PipelineJob[] {
    const rows = this.db.prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs
       WHERE user_id = ?
         AND status IN ('new', 'extracted', 'scored', 'composed', 'audit_failed')
       ORDER BY id`,
    ).all(userId) as JobRow[];
    return rows.map(toPipelineJob);
  }

  listForStage(userId: number, stage: PipelineStage): PipelineJob[] {
    let predicate: string;
    switch (stage) {
      case 'extract':
        predicate = 'title IS NULL';
        break;
      case 'score':
        predicate = 'title IS NOT NULL AND score IS NULL';
        break;
      case 'compose':
        predicate = "status IN ('scored', 'audit_failed') AND score > 0 AND tier IN ('A', 'B')";
        break;
      case 'audit':
        predicate = "status = 'composed'";
        break;
    }
    const rows = this.db.prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE user_id = ? AND ${predicate} ORDER BY id`,
    ).all(userId) as JobRow[];
    return rows.map(toPipelineJob);
  }

  findOwned(jobId: number, userId: number): PipelineJob | undefined {
    const row = this.db.prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ? AND user_id = ?`,
    ).get(jobId, userId) as JobRow | undefined;
    return row ? toPipelineJob(row) : undefined;
  }

  saveScore(jobId: number, userId: number, result: ScoreStageResult): void {
    const transaction = this.db.transaction(() => {
      const update = this.db.prepare(
        `UPDATE jobs
         SET score = ?, tier = ?, score_reason = ?, status = 'scored', updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`,
      ).run(result.score, result.tier, result.reason, jobId, userId);
      if (update.changes !== 1) {
        throw new Error(`Job ${jobId} does not belong to user ${userId}`);
      }
      this.db.prepare(
        `INSERT INTO user_scores
           (job_id, user_id, score, tier, score_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(job_id, user_id) DO UPDATE SET
           score = excluded.score,
           tier = excluded.tier,
           score_reason = excluded.score_reason,
           updated_at = datetime('now')`,
      ).run(jobId, userId, result.score, result.tier, result.reason);
    });
    transaction();
  }

  recordStage(record: StageRecord): void {
    const key = `${record.userId}:${record.jobId}:${record.stage}`;
    const jobKey = `${record.userId}:${record.jobId}`;
    if (record.outcome === 'started') {
      const parentRunId = typeof record.metadata?.audit_retry === 'number'
        ? this.activeJobRuns.get(jobKey)
        : undefined;
      const runId = parentRunId ?? this.runs.start(record.jobId, record.userId, 'application-service', {
        profile_id: record.profileId,
      }).id;
      const stageRun = this.runs.startStage(runId, record.stage, {
        profile_id: record.profileId,
      });
      const ownsRun = parentRunId === undefined;
      this.activeRuns.set(key, { runId, stageRunId: stageRun.id, ownsRun });
      if (ownsRun) this.activeJobRuns.set(jobKey, runId);
    } else {
      const active = this.activeRuns.get(key);
      if (active) {
        const stageStatus: Exclude<StageStatus, 'running'> = record.outcome;
        this.runs.finishStage(active.stageRunId, stageStatus, undefined, record.error);
        const runStatus: Exclude<RunStatus, 'running'> = record.outcome === 'skipped'
          ? 'succeeded'
          : record.outcome;
        if (active.ownsRun) {
          this.runs.finish(active.runId, runStatus, record.error);
          this.activeJobRuns.delete(jobKey);
        }
        this.activeRuns.delete(key);
      }
    }

    // Keep the legacy event stream populated while UI readers migrate to
    // pipeline_runs/stage_runs.
    this.db.prepare(
      `INSERT INTO events (job_id, event_type, description, metadata, created_at)
       VALUES (?, 'pipeline_stage', ?, ?, datetime('now'))`,
    ).run(
      record.jobId,
      `${record.stage}:${record.outcome}${record.error ? ` — ${record.error.slice(0, 200)}` : ''}`,
      JSON.stringify({
        user_id: record.userId,
        profile_id: record.profileId,
        stage: record.stage,
        outcome: record.outcome,
        error: record.error,
        ...record.metadata,
      }),
    );
  }
}
