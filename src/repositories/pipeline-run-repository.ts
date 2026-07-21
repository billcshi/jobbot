import type Database from 'better-sqlite3';
import { getDb } from '../db/client.js';
import { parseJsonObject, stringifyJson, type JsonObject } from '../domain/shared/json.js';
import { optionalString, requiredNumber, requiredString } from '../domain/shared/rows.js';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type StageStatus = RunStatus | 'skipped';

export interface PipelineRun {
  id: number;
  jobId: number;
  trigger: string;
  status: RunStatus;
  input: JsonObject;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface StageRun {
  id: number;
  pipelineRunId: number;
  stage: string;
  attempt: number;
  status: StageStatus;
}

export class PipelineRunRepository {
  public constructor(private readonly db: Database.Database = getDb()) {}

  public start(jobId: number, userId: number, trigger: string, input: JsonObject = {}): PipelineRun {
    assertId(jobId, 'jobId');
    assertId(userId, 'userId');
    if (!trigger.trim()) throw new Error('Pipeline trigger is required');
    const job = this.db.prepare('SELECT user_id FROM jobs WHERE id = ?').get(jobId) as
      | { user_id: number | null }
      | undefined;
    if (!job) throw new Error(`Job ${jobId} does not exist`);
    if (job.user_id === null) throw new Error(`Job ${jobId} has no owner`);
    if (userId !== job.user_id) {
      throw new Error(`Job ${jobId} is not owned by user ${userId}`);
    }
    let result: Database.RunResult;
    try {
      result = this.db.prepare(`
        INSERT INTO pipeline_runs (job_id, user_id, trigger, input_json) VALUES (?, ?, ?, ?)
      `).run(jobId, job.user_id, trigger, stringifyJson(input));
    } catch (error) {
      if (isActiveRunConstraint(error)) {
        throw new Error(`Job ${jobId} already has an active pipeline run for user ${userId}`, { cause: error });
      }
      throw error;
    }
    return this.requireRun(Number(result.lastInsertRowid));
  }

  public finish(runId: number, status: Exclude<RunStatus, 'running'>, errorMessage?: string): PipelineRun {
    assertId(runId, 'runId');
    const result = this.db.prepare(`
      UPDATE pipeline_runs SET status = ?, error_message = ?, finished_at = datetime('now')
      WHERE id = ? AND status = 'running'
    `).run(status, errorMessage ?? null, runId);
    if (result.changes === 0) throwTransitionError(this.db, 'Pipeline run', 'pipeline_runs', runId);
    return this.requireRun(runId);
  }

  public startStage(
    pipelineRunId: number,
    stage: string,
    input: JsonObject = {},
    attempt?: number,
  ): StageRun {
    assertId(pipelineRunId, 'pipelineRunId');
    if (!stage.trim()) throw new Error('Stage name is required');
    const actualAttempt = attempt ?? this.nextAttempt(pipelineRunId, stage);
    if (!Number.isInteger(actualAttempt) || actualAttempt <= 0) throw new Error('attempt must be positive');
    const result = this.db.prepare(`
      INSERT INTO stage_runs (pipeline_run_id, stage, attempt, input_json) VALUES (?, ?, ?, ?)
    `).run(pipelineRunId, stage, actualAttempt, stringifyJson(input));
    return this.requireStage(Number(result.lastInsertRowid));
  }

  public finishStage(
    stageRunId: number,
    status: Exclude<StageStatus, 'running'>,
    output?: JsonObject,
    errorMessage?: string,
  ): StageRun {
    assertId(stageRunId, 'stageRunId');
    const result = this.db.prepare(`
      UPDATE stage_runs
      SET status = ?, output_json = ?, error_message = ?, finished_at = datetime('now')
      WHERE id = ? AND status = 'running'
    `).run(status, output === undefined ? null : stringifyJson(output), errorMessage ?? null, stageRunId);
    if (result.changes === 0) throwTransitionError(this.db, 'Stage run', 'stage_runs', stageRunId);
    return this.requireStage(stageRunId);
  }

  public get(runId: number): PipelineRun | null {
    assertId(runId, 'runId');
    const row = this.db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRun(row) : null;
  }

  private nextAttempt(pipelineRunId: number, stage: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
      FROM stage_runs WHERE pipeline_run_id = ? AND stage = ?
    `).get(pipelineRunId, stage) as Record<string, unknown>;
    return requiredNumber(row, 'attempt');
  }

  private requireRun(runId: number): PipelineRun {
    const run = this.get(runId);
    if (!run) throw new Error(`Pipeline run ${runId} does not exist`);
    return run;
  }

  private requireStage(stageRunId: number): StageRun {
    const row = this.db.prepare('SELECT * FROM stage_runs WHERE id = ?').get(stageRunId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Stage run ${stageRunId} does not exist`);
    const status = requiredString(row, 'status');
    if (!isStageStatus(status)) throw new Error(`Unknown stage status: ${status}`);
    return {
      id: requiredNumber(row, 'id'),
      pipelineRunId: requiredNumber(row, 'pipeline_run_id'),
      stage: requiredString(row, 'stage'),
      attempt: requiredNumber(row, 'attempt'),
      status,
    };
  }
}

function isActiveRunConstraint(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE'
    && error.message.includes('pipeline_runs.job_id')
    && error.message.includes('pipeline_runs.user_id');
}

function mapRun(row: Record<string, unknown>): PipelineRun {
  const status = requiredString(row, 'status');
  if (!isRunStatus(status)) throw new Error(`Unknown pipeline status: ${status}`);
  return {
    id: requiredNumber(row, 'id'),
    jobId: requiredNumber(row, 'job_id'),
    trigger: requiredString(row, 'trigger'),
    status,
    input: parseJsonObject(requiredString(row, 'input_json'), 'input_json'),
    errorMessage: optionalString(row, 'error_message'),
    startedAt: requiredString(row, 'started_at'),
    finishedAt: optionalString(row, 'finished_at'),
  };
}

function isRunStatus(value: string): value is RunStatus {
  return value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled';
}

function isStageStatus(value: string): value is StageStatus {
  return isRunStatus(value) || value === 'skipped';
}

function assertId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function throwTransitionError(
  db: Database.Database,
  label: string,
  table: 'pipeline_runs' | 'stage_runs',
  id: number,
): never {
  const row = db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`${label} ${id} does not exist`);
  throw new Error(`${label} ${id} is already terminal (${requiredString(row, 'status')})`);
}
