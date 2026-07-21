import type { AppContext } from '../../utils/app-context.js';

export type PipelineStage = 'extract' | 'score' | 'compose' | 'audit';
export type StageOutcome = 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface PipelineJob {
  id: number;
  userId: number;
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  score: number | null;
  tier: string | null;
  status: string;
}

export interface ExtractStageResult {
  success: boolean;
  title: string;
  company: string;
  error?: string;
}

export interface ScoreStageResult {
  score: number;
  tier: string;
  reason: string;
}

export interface ComposeStageResult {
  success: boolean;
  pdfPath?: string;
  error?: string;
}

export interface AuditStageResult {
  success: boolean;
  overallScore: number;
  error?: string;
}

export interface PipelineExecutors {
  extract(jobId: number, signal?: AbortSignal): Promise<ExtractStageResult>;
  score(job: PipelineJob, context: AppContext, signal?: AbortSignal): Promise<ScoreStageResult>;
  compose(jobId: number, context: AppContext, signal?: AbortSignal): Promise<ComposeStageResult>;
  audit(jobId: number, context: AppContext, signal?: AbortSignal): Promise<AuditStageResult>;
  afterScore?(job: PipelineJob): void;
}

export interface StageRecord {
  userId: number;
  profileId: number;
  jobId: number;
  stage: PipelineStage;
  outcome: 'started' | StageOutcome;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface PipelineRepository {
  listPending(userId: number): PipelineJob[];
  listForStage(userId: number, stage: PipelineStage): PipelineJob[];
  findOwned(jobId: number, userId: number): PipelineJob | undefined;
  saveScore(jobId: number, userId: number, result: ScoreStageResult): void;
  recordStage(record: StageRecord): void;
}

/** Structural subset implemented by the existing PipelineStateTracker. */
export interface PipelineProgress {
  readonly signal: AbortSignal | null;
  /** Returns false when a caller already reserved the tracker. */
  startPipeline(): boolean;
  finishPipeline(): void;
  startStage(stage: PipelineStage, total: number): void;
  finishStage(stage: PipelineStage): void;
  taskStarted(
    stage: PipelineStage,
    jobId: number,
    meta?: { title?: string; company?: string },
  ): AbortController;
  taskCompleted(stage: PipelineStage, jobId: number): void;
  taskFailed(stage: PipelineStage, jobId: number): void;
  taskCancelled(stage: PipelineStage, jobId: number): void;
  updateTaskMeta(
    stage: PipelineStage,
    jobId: number,
    meta: { title?: string; company?: string },
  ): void;
}

export interface StageSummary {
  stage: PipelineStage;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

export interface PipelineSummary {
  total: number;
  stages: Record<PipelineStage, StageSummary>;
}
