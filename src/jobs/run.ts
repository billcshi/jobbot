/**
 * Backward-compatible entry points for the canonical pipeline service.
 *
 * New web/background callers should pass an AppContext explicitly. The
 * default context exists only for the legacy single-process CLI surface.
 */
import { createDefaultPipeline } from '../application/pipeline/default-pipeline.js';
import type { StageSummary } from '../application/pipeline/types.js';
import { getPipelineManager, getPipelineState } from './pipeline-state.js';
import type { AppContext } from '../utils/app-context.js';
import { legacyAppContext } from '../utils/app-context.js';
import { getConcurrency } from '../utils/config.js';

type Progress = ReturnType<typeof getPipelineState>;

function printStageSummary(summary: StageSummary): void {
  if (summary.total === 0) {
    console.log(`No queued jobs for ${summary.stage}.`);
    return;
  }
  const parts = [
    `${summary.succeeded} succeeded`,
    `${summary.failed} failed`,
  ];
  if (summary.cancelled) parts.push(`${summary.cancelled} cancelled`);
  if (summary.skipped) parts.push(`${summary.skipped} skipped`);
  console.log(`${summary.stage} done: ${parts.join(', ')}.`);
}

function pipeline(context: AppContext, state: Progress, concurrency?: number) {
  const perStage = concurrency === undefined
    ? undefined
    : { extract: concurrency, score: concurrency, compose: concurrency, audit: concurrency };
  return createDefaultPipeline(context, {
    progress: state,
    concurrency: perStage,
    log: console.log,
  });
}

export async function runExtract(
  concurrency?: number,
  state: Progress = getPipelineState(),
  context: AppContext = legacyAppContext(),
): Promise<void> {
  printStageSummary(await pipeline(context, state).runStage('extract', concurrency));
}

export async function runScore(
  concurrency?: number,
  state: Progress = getPipelineState(),
  context: AppContext = legacyAppContext(),
): Promise<void> {
  printStageSummary(await pipeline(context, state).runStage('score', concurrency));
}

export async function runCompose(
  concurrency?: number,
  state: Progress = getPipelineState(),
  context: AppContext = legacyAppContext(),
): Promise<void> {
  printStageSummary(await pipeline(context, state).runStage('compose', concurrency));
}

export async function runAudit(
  concurrency?: number,
  state: Progress = getPipelineState(),
  context: AppContext = legacyAppContext(),
): Promise<void> {
  printStageSummary(await pipeline(context, state).runStage('audit', concurrency));
}

export async function runAll(
  state: Progress = getPipelineState(),
  context: AppContext = legacyAppContext(),
): Promise<void> {
  // Capacity remains an infrastructure concern of the legacy web adapter.
  // The application service itself is deterministic for an explicit context.
  const capacity = getPipelineManager().checkCapacity(context.userId, Number.MAX_SAFE_INTEGER);
  if (!capacity.allowed) {
    console.log(`Blocked: ${capacity.reason}`);
    return;
  }

  await runAllForContext(context, state, capacity.concurrency);
}

/**
 * Run the complete pipeline for an explicitly bound application context.
 *
 * Background and web adapters use this entry point so they cannot silently
 * fall back to the process-global CLI identity. Callers are responsible for
 * reserving the supplied per-user progress tracker before launching work.
 */
export async function runAllForContext(
  context: AppContext,
  state: Progress,
  concurrency?: number,
): Promise<void> {
  const effectiveConcurrency = concurrency ?? getConcurrency().per_user;

  const summary = await pipeline(context, state, effectiveConcurrency).runAll();
  if (summary.total === 0) {
    console.log('No jobs to process.');
    return;
  }
  const completed = Object.values(summary.stages).reduce((sum, stage) => sum + stage.succeeded, 0);
  const failed = Object.values(summary.stages).reduce((sum, stage) => sum + stage.failed, 0);
  const config = getConcurrency();
  console.log(`Pipeline complete: ${summary.total} job(s), ${completed} stage(s) succeeded, ${failed} failed (global cap ${config.global}).`);
}

export async function runJob(
  jobId: number,
  state: Progress = getPipelineState(),
  context: AppContext = legacyAppContext(),
): Promise<void> {
  console.log(`=== Pipeline: Job #${jobId} ===`);
  try {
    const summary = await pipeline(context, state).runJob(jobId);
    const failed = Object.values(summary.stages).reduce((sum, stage) => sum + stage.failed, 0);
    console.log(failed === 0 ? '=== Pipeline Complete ===' : `=== Pipeline stopped: ${failed} stage(s) failed ===`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Pipeline stopped: ${message}`);
  }
}
