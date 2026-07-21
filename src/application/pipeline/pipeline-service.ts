import { asyncPool } from '../../utils/async-pool.js';
import type { AppContext } from '../../utils/app-context.js';
import type {
  PipelineExecutors,
  PipelineJob,
  PipelineProgress,
  PipelineRepository,
  PipelineStage,
  PipelineSummary,
  StageOutcome,
  StageSummary,
} from './types.js';

const STAGES: readonly PipelineStage[] = ['extract', 'score', 'compose', 'audit'];

export interface PipelineServiceOptions {
  readonly context: AppContext;
  readonly repository: PipelineRepository;
  readonly executors: PipelineExecutors;
  readonly progress: PipelineProgress;
  readonly concurrency?: Partial<Record<PipelineStage, number>>;
  readonly maxAuditAttempts?: number;
  readonly log?: (message: string) => void;
}

function emptySummary(stage: PipelineStage, total = 0): StageSummary {
  return { stage, total, succeeded: 0, failed: 0, cancelled: 0, skipped: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

function count(summary: StageSummary, outcome: StageOutcome): void {
  switch (outcome) {
    case 'succeeded': summary.succeeded++; break;
    case 'failed': summary.failed++; break;
    case 'cancelled': summary.cancelled++; break;
    case 'skipped': summary.skipped++; break;
  }
}

function isStageOutcome(value: unknown): value is StageOutcome {
  return value === 'succeeded' || value === 'failed' || value === 'cancelled' || value === 'skipped';
}

/**
 * Canonical pipeline application service.
 *
 * Identity, persistence, execution and progress reporting are injected.  This
 * makes the orchestration safe for concurrent profiles and testable without a
 * process-global current user.
 */
export class PipelineService {
  private readonly context: AppContext;
  private readonly repository: PipelineRepository;
  private readonly executors: PipelineExecutors;
  private readonly progress: PipelineProgress;
  private readonly concurrency: Record<PipelineStage, number>;
  private readonly maxAuditAttempts: number;
  private readonly log: (message: string) => void;

  constructor(options: PipelineServiceOptions) {
    this.context = options.context;
    this.repository = options.repository;
    this.executors = options.executors;
    this.progress = options.progress;
    this.maxAuditAttempts = Math.max(1, options.maxAuditAttempts ?? 3);
    this.log = options.log ?? (() => undefined);
    this.concurrency = {
      extract: Math.max(1, options.concurrency?.extract ?? 5),
      score: Math.max(1, options.concurrency?.score ?? 3),
      compose: Math.max(1, options.concurrency?.compose ?? 2),
      audit: Math.max(1, options.concurrency?.audit ?? 2),
    };
  }

  async runStage(stage: PipelineStage, concurrency?: number): Promise<StageSummary> {
    const jobs = this.repository.listForStage(this.context.userId, stage);
    const summary = emptySummary(stage, jobs.length);
    this.progress.startStage(stage, jobs.length);

    try {
      const results = await asyncPool<PipelineJob>(
        Math.max(1, concurrency ?? this.concurrency[stage]),
        jobs,
        (job) => this.execute(stage, job),
        { signal: this.progress.signal ?? undefined },
      );
      for (const result of results) {
        if (result.skipped) count(summary, 'cancelled');
        else if (isStageOutcome(result.result)) count(summary, result.result);
        else count(summary, 'failed');
      }
      return summary;
    } finally {
      this.progress.finishStage(stage);
    }
  }

  async runAll(): Promise<PipelineSummary> {
    const summaries = {
      extract: emptySummary('extract'),
      score: emptySummary('score'),
      compose: emptySummary('compose'),
      audit: emptySummary('audit'),
    };

    this.progress.startPipeline();
    try {
      const initial = this.repository.listPending(this.context.userId);
      if (initial.length === 0) return { total: 0, stages: summaries };
      for (const stage of STAGES) {
        summaries[stage] = await this.runStage(stage);
        if (this.progress.signal?.aborted) break;
      }
      return { total: initial.length, stages: summaries };
    } finally {
      this.progress.finishPipeline();
    }
  }

  async runJob(jobId: number): Promise<PipelineSummary> {
    this.progress.startPipeline();
    const summaries = {
      extract: emptySummary('extract'),
      score: emptySummary('score'),
      compose: emptySummary('compose'),
      audit: emptySummary('audit'),
    };
    try {
      const initial = this.repository.findOwned(jobId, this.context.userId);
      if (!initial) throw new Error(`Job ${jobId} not found for user ${this.context.userId}`);
      for (const stage of STAGES) {
        const job = this.repository.findOwned(jobId, this.context.userId);
        if (!job || !this.needsStage(job, stage)) continue;
        const summary = emptySummary(stage, 1);
        summaries[stage] = summary;
        this.progress.startStage(stage, 1);
        try {
          const outcome = await this.execute(stage, job);
          count(summary, outcome);
          if (outcome !== 'succeeded') break;
        } finally {
          this.progress.finishStage(stage);
        }
      }
      return { total: 1, stages: summaries };
    } finally {
      this.progress.finishPipeline();
    }
  }

  /** Run an owned job from an explicitly selected stage through audit. */
  async runJobFrom(jobId: number, startStage: PipelineStage): Promise<PipelineSummary> {
    this.progress.startPipeline();
    const summaries = {
      extract: emptySummary('extract'),
      score: emptySummary('score'),
      compose: emptySummary('compose'),
      audit: emptySummary('audit'),
    };
    const startIndex = STAGES.indexOf(startStage);
    try {
      const initial = this.repository.findOwned(jobId, this.context.userId);
      if (!initial) throw new Error(`Job ${jobId} not found for user ${this.context.userId}`);
      for (let index = startIndex; index < STAGES.length; index++) {
        const stage = STAGES[index]!;
        const job = this.repository.findOwned(jobId, this.context.userId);
        if (!job) break;
        const summary = emptySummary(stage, 1);
        summaries[stage] = summary;
        this.progress.startStage(stage, 1);
        try {
          const outcome = await this.execute(stage, job);
          count(summary, outcome);
          if (outcome !== 'succeeded') break;
        } finally {
          this.progress.finishStage(stage);
        }
      }
      return { total: 1, stages: summaries };
    } finally {
      this.progress.finishPipeline();
    }
  }

  /** Run one explicitly requested stage for one owned job. */
  async runJobStage(jobId: number, stage: PipelineStage): Promise<StageSummary> {
    this.progress.startPipeline();
    try {
      const job = this.repository.findOwned(jobId, this.context.userId);
      if (!job) throw new Error(`Job ${jobId} not found for user ${this.context.userId}`);
      const summary = emptySummary(stage, 1);
      this.progress.startStage(stage, 1);
      count(summary, await this.execute(stage, job));
      return summary;
    } finally {
      this.progress.finishStage(stage);
      this.progress.finishPipeline();
    }
  }

  private needsStage(job: PipelineJob, stage: PipelineStage): boolean {
    switch (stage) {
      case 'extract': return !job.title;
      case 'score': return Boolean(job.title) && job.score === null;
      case 'compose':
        return (job.status === 'scored' || job.status === 'audit_failed')
          && (job.tier === 'A' || job.tier === 'B')
          && job.score !== null
          && job.score > 0;
      case 'audit': return job.status === 'composed';
    }
  }

  private execute(stage: PipelineStage, job: PipelineJob): Promise<StageOutcome> {
    switch (stage) {
      case 'extract': return this.executeExtract(job);
      case 'score': return this.executeScore(job);
      case 'compose': return this.executeCompose(job);
      case 'audit': return this.executeAudit(job);
    }
  }

  private start(stage: PipelineStage, job: PipelineJob): AbortController {
    const controller = this.progress.taskStarted(stage, job.id, {
      title: job.title ?? undefined,
      company: job.company ?? undefined,
    });
    this.repository.recordStage({
      userId: this.context.userId,
      profileId: this.context.profileId,
      jobId: job.id,
      stage,
      outcome: 'started',
    });
    return controller;
  }

  private finish(stage: PipelineStage, jobId: number, outcome: StageOutcome, error?: string): StageOutcome {
    if (outcome === 'succeeded' || outcome === 'skipped') this.progress.taskCompleted(stage, jobId);
    else if (outcome === 'cancelled') this.progress.taskCancelled(stage, jobId);
    else this.progress.taskFailed(stage, jobId);
    this.repository.recordStage({
      userId: this.context.userId,
      profileId: this.context.profileId,
      jobId,
      stage,
      outcome,
      error,
    });
    return outcome;
  }

  private async executeExtract(job: PipelineJob): Promise<StageOutcome> {
    const controller = this.start('extract', job);
    try {
      const result = await this.executors.extract(job.id, controller.signal);
      if (controller.signal.aborted) return this.finish('extract', job.id, 'cancelled');
      if (!result.success) return this.finish('extract', job.id, 'failed', result.error ?? 'Extraction failed');
      this.progress.updateTaskMeta('extract', job.id, { title: result.title, company: result.company });
      this.log(`✓ #${job.id} extracted: "${result.title}" at ${result.company}`);
      return this.finish('extract', job.id, 'succeeded');
    } catch (error) {
      if (isCancellation(error, controller.signal)) return this.finish('extract', job.id, 'cancelled');
      return this.finish('extract', job.id, 'failed', errorMessage(error));
    }
  }

  private async executeScore(job: PipelineJob): Promise<StageOutcome> {
    const controller = this.start('score', job);
    try {
      const result = await this.executors.score(job, this.context, controller.signal);
      if (controller.signal.aborted) return this.finish('score', job.id, 'cancelled');
      this.repository.saveScore(job.id, this.context.userId, result);
      this.executors.afterScore?.(job);
      this.log(`✓ #${job.id} scored: ${result.tier} (${result.score.toFixed(2)})`);
      return this.finish('score', job.id, 'succeeded');
    } catch (error) {
      if (isCancellation(error, controller.signal)) return this.finish('score', job.id, 'cancelled');
      const message = errorMessage(error);
      this.log(`✕ #${job.id} score failed: ${message}`);
      // Deliberately do not write a deterministic placeholder as a real score.
      return this.finish('score', job.id, 'failed', message);
    }
  }

  private async executeCompose(job: PipelineJob): Promise<StageOutcome> {
    const controller = this.start('compose', job);
    try {
      const result = await this.executors.compose(job.id, this.context, controller.signal);
      if (controller.signal.aborted) return this.finish('compose', job.id, 'cancelled');
      if (!result.success) return this.finish('compose', job.id, 'failed', result.error ?? 'Compose failed');
      this.log(`✓ #${job.id} composed${result.pdfPath ? `: ${result.pdfPath}` : ''}`);
      return this.finish('compose', job.id, 'succeeded');
    } catch (error) {
      if (isCancellation(error, controller.signal)) return this.finish('compose', job.id, 'cancelled');
      return this.finish('compose', job.id, 'failed', errorMessage(error));
    }
  }

  private async executeAudit(job: PipelineJob): Promise<StageOutcome> {
    const controller = this.start('audit', job);
    try {
      for (let attempt = 1; attempt <= this.maxAuditAttempts; attempt++) {
        const result = await this.executors.audit(job.id, this.context, controller.signal);
        if (controller.signal.aborted) return this.finish('audit', job.id, 'cancelled');
        if (!result.success) return this.finish('audit', job.id, 'failed', result.error ?? 'Audit failed');

        const current = this.repository.findOwned(job.id, this.context.userId);
        if (current?.status === 'audited') {
          this.log(`✓ #${job.id} audited: ${result.overallScore}/100`);
          return this.finish('audit', job.id, 'succeeded');
        }
        if (attempt === this.maxAuditAttempts) {
          return this.finish('audit', job.id, 'failed', `Audit did not pass after ${attempt} attempts`);
        }

        this.repository.recordStage({
          userId: this.context.userId,
          profileId: this.context.profileId,
          jobId: job.id,
          stage: 'compose',
          outcome: 'started',
          metadata: { audit_retry: attempt },
        });
        let compose: Awaited<ReturnType<PipelineExecutors['compose']>>;
        try {
          compose = await this.executors.compose(job.id, this.context, controller.signal);
        } catch (error) {
          const cancelled = isCancellation(error, controller.signal);
          const message = errorMessage(error);
          this.repository.recordStage({
            userId: this.context.userId,
            profileId: this.context.profileId,
            jobId: job.id,
            stage: 'compose',
            outcome: cancelled ? 'cancelled' : 'failed',
            error: cancelled ? undefined : message,
            metadata: { audit_retry: attempt },
          });
          return this.finish('audit', job.id, cancelled ? 'cancelled' : 'failed', cancelled ? undefined : message);
        }
        if (controller.signal.aborted) {
          this.repository.recordStage({
            userId: this.context.userId,
            profileId: this.context.profileId,
            jobId: job.id,
            stage: 'compose',
            outcome: 'cancelled',
            metadata: { audit_retry: attempt },
          });
          return this.finish('audit', job.id, 'cancelled');
        }
        this.repository.recordStage({
          userId: this.context.userId,
          profileId: this.context.profileId,
          jobId: job.id,
          stage: 'compose',
          outcome: compose.success ? 'succeeded' : 'failed',
          error: compose.error,
          metadata: { audit_retry: attempt },
        });
        if (!compose.success) {
          return this.finish('audit', job.id, 'failed', compose.error ?? 'Audit retry compose failed');
        }
      }
      return this.finish('audit', job.id, 'failed', 'Audit retry limit reached');
    } catch (error) {
      if (isCancellation(error, controller.signal)) return this.finish('audit', job.id, 'cancelled');
      return this.finish('audit', job.id, 'failed', errorMessage(error));
    }
  }
}
