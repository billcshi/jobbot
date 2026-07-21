import { describe, expect, it, vi } from 'vitest';
import { PipelineService } from '../src/application/pipeline/pipeline-service';
import { parseScoreResponse } from '../src/jobs/scorers/llm.js';
import type {
  PipelineExecutors,
  PipelineJob,
  PipelineProgress,
  PipelineRepository,
  PipelineStage,
  ScoreStageResult,
  StageRecord,
} from '../src/application/pipeline/types';

function job(id: number, userId: number): PipelineJob {
  return {
    id,
    userId,
    title: `Engineer ${id}`,
    company: 'Example',
    location: 'Remote',
    description: 'Build things',
    score: null,
    tier: null,
    status: 'extracted',
  };
}

class MemoryRepository implements PipelineRepository {
  readonly jobs: PipelineJob[];
  readonly scores: Array<{ jobId: number; profileId: number; result: ScoreStageResult }> = [];
  readonly records: StageRecord[] = [];

  constructor(jobs: PipelineJob[]) {
    this.jobs = jobs;
  }

  listPending(userId: number): PipelineJob[] {
    return this.jobs.filter((candidate) => candidate.userId === userId);
  }

  listForStage(userId: number, stage: PipelineStage): PipelineJob[] {
    if (stage !== 'score') return [];
    return this.jobs.filter((candidate) => candidate.userId === userId && candidate.score === null);
  }

  findOwned(jobId: number, userId: number): PipelineJob | undefined {
    return this.jobs.find((candidate) => candidate.id === jobId && candidate.userId === userId);
  }

  saveScore(jobId: number, userId: number, result: ScoreStageResult): void {
    const owned = this.findOwned(jobId, userId);
    if (!owned) throw new Error('not owned');
    owned.score = result.score;
    owned.tier = result.tier;
    owned.status = 'scored';
    this.scores.push({ jobId, profileId: userId, result });
  }

  recordStage(record: StageRecord): void {
    this.records.push(record);
  }
}

function progress(): PipelineProgress {
  return {
    signal: null,
    startPipeline: vi.fn(() => true),
    finishPipeline: vi.fn(),
    startStage: vi.fn(),
    finishStage: vi.fn(),
    taskStarted: vi.fn(() => new AbortController()),
    taskCompleted: vi.fn(),
    taskFailed: vi.fn(),
    taskCancelled: vi.fn(),
    updateTaskMeta: vi.fn(),
  };
}

function alreadyCancelledProgress(): PipelineProgress {
  const base = progress();
  return {
    ...base,
    taskStarted: vi.fn(() => {
      const controller = new AbortController();
      controller.abort();
      return controller;
    }),
  };
}

function executors(score: PipelineExecutors['score']): PipelineExecutors {
  return {
    extract: vi.fn(async () => ({ success: true, title: 'Engineer', company: 'Example' })),
    score,
    compose: vi.fn(async () => ({ success: true })),
    audit: vi.fn(async () => ({ success: true, overallScore: 90 })),
  };
}

describe('PipelineService explicit profile context', () => {
  it('only scores jobs owned by the supplied profile', async () => {
    const repository = new MemoryRepository([job(1, 10), job(2, 20)]);
    const score = vi.fn(async (_job: PipelineJob) => ({ score: 0.9, tier: 'A', reason: 'match' }));
    const service = new PipelineService({
      context: { userId: 10, profileId: 100, profileName: 'alice' },
      repository,
      executors: executors(score),
      progress: progress(),
    });

    const result = await service.runStage('score');

    expect(result.succeeded).toBe(1);
    expect(score).toHaveBeenCalledTimes(1);
    expect(score.mock.calls[0]?.[0].id).toBe(1);
    expect(repository.scores.map(({ profileId }) => profileId)).toEqual([10]);
    expect(repository.jobs[1]?.score).toBeNull();
  });

  it('keeps a job unscored when the scorer fails', async () => {
    const candidate = job(1, 10);
    const repository = new MemoryRepository([candidate]);
    const service = new PipelineService({
      context: { userId: 10, profileId: 100, profileName: 'alice' },
      repository,
      executors: executors(vi.fn(async () => { throw new Error('provider unavailable'); })),
      progress: progress(),
    });

    const result = await service.runStage('score');

    expect(result.failed).toBe(1);
    expect(candidate.score).toBeNull();
    expect(candidate.status).toBe('extracted');
    expect(repository.scores).toHaveLength(0);
    expect(repository.records).toContainEqual(expect.objectContaining({
      userId: 10,
      profileId: 100,
      jobId: 1,
      stage: 'score',
      outcome: 'failed',
      error: 'provider unavailable',
    }));
  });

  it('keeps a job unscored and fails the stage for a malformed LLM score', async () => {
    const candidate = job(1, 10);
    const repository = new MemoryRepository([candidate]);
    const service = new PipelineService({
      context: { userId: 10, profileId: 100, profileName: 'alice' },
      repository,
      executors: executors(vi.fn(async () => parseScoreResponse({}))),
      progress: progress(),
    });

    const result = await service.runStage('score');

    expect(result.failed).toBe(1);
    expect(candidate.score).toBeNull();
    expect(candidate.status).toBe('extracted');
    expect(repository.scores).toHaveLength(0);
    expect(repository.records).toContainEqual(expect.objectContaining({
      stage: 'score',
      outcome: 'failed',
      error: expect.stringContaining('Invalid score response'),
    }));
  });

  it('rejects a single-job run owned by another profile', async () => {
    const repository = new MemoryRepository([job(2, 20)]);
    const service = new PipelineService({
      context: { userId: 10, profileId: 100, profileName: 'alice' },
      repository,
      executors: executors(vi.fn()),
      progress: progress(),
    });

    await expect(service.runJob(2)).rejects.toThrow('not found for user 10');
  });

  it.each<PipelineStage>(['extract', 'score', 'compose', 'audit'])(
    'records %s as cancelled when its executor resolves after cancellation',
    async (stage) => {
      const repository = new MemoryRepository([job(1, 10)]);
      const tracker = alreadyCancelledProgress();
      const service = new PipelineService({
        context: { userId: 10, profileId: 100, profileName: 'alice' },
        repository,
        executors: executors(vi.fn(async () => ({ score: 0.9, tier: 'A', reason: 'match' }))),
        progress: tracker,
      });

      const result = await service.runJobStage(1, stage);

      expect(result.cancelled).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(repository.scores).toHaveLength(0);
      expect(repository.records).toContainEqual(expect.objectContaining({ stage, outcome: 'cancelled' }));
      expect(repository.records).not.toContainEqual(expect.objectContaining({ stage, outcome: 'succeeded' }));
      expect(tracker.taskCancelled).toHaveBeenCalledWith(stage, 1);
      expect(tracker.taskCompleted).not.toHaveBeenCalled();
    },
  );
});
