import { getDb } from '../../db/client.js';
import { auditJob } from '../../jobs/audit.js';
import { composeJob } from '../../jobs/compose.js';
import { extractJob } from '../../jobs/extract.js';
import { extractMarketData } from '../../jobs/market-data.js';
import { getPipelineState } from '../../jobs/pipeline-state.js';
import { scoreJobWithLLM } from '../../jobs/scorers/llm.js';
import { getStageConcurrency } from '../../utils/config.js';
import type { AppContext } from '../../utils/app-context.js';
import { PipelineService } from './pipeline-service.js';
import { SqlitePipelineRepository } from './sqlite-pipeline-repository.js';
import type { PipelineProgress, PipelineStage } from './types.js';

export interface DefaultPipelineOptions {
  progress?: PipelineProgress;
  concurrency?: Partial<Record<PipelineStage, number>>;
  log?: (message: string) => void;
  scoreInstruction?: string;
  fixLatex?: boolean;
}

/** Wire the application service to the current SQLite/LLM implementation. */
export function createDefaultPipeline(
  context: AppContext,
  options: DefaultPipelineOptions = {},
): PipelineService {
  const db = getDb();
  return new PipelineService({
    context,
    repository: new SqlitePipelineRepository(db),
    progress: options.progress ?? getPipelineState(),
    concurrency: options.concurrency ?? {
      extract: getStageConcurrency('extract'),
      score: getStageConcurrency('score'),
      compose: getStageConcurrency('compose'),
      audit: getStageConcurrency('audit'),
    },
    log: options.log,
    executors: {
      extract: (jobId, signal) => extractJob(jobId, signal, context.userId),
      score: (job, appContext, signal) => scoreJobWithLLM(job, options.scoreInstruction, signal, appContext.userId),
      compose: (jobId, appContext, signal) => composeJob(
        jobId,
        undefined,
        signal,
        options.fixLatex === undefined ? undefined : { fixLatex: options.fixLatex },
        appContext.userId,
      ),
      audit: (jobId, appContext, signal) => auditJob(jobId, signal, appContext.userId),
      afterScore: (job) => extractMarketData(job, context.userId),
    },
  });
}
