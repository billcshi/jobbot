/**
 * Scheduled Pipeline Runs — v0.5
 *
 * Simple interval-based pipeline scheduling. Uses `setInterval` when running
 * inside the UI server process, or a one-shot mode for CLI use.
 *
 * CLI:
 *   pnpm jobbot schedule --interval <minutes>   recurring
 *   pnpm jobbot schedule --once                  run once and exit
 */

import { runAll } from './run.js';
import { logger } from '../utils/logger.js';

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Run the pipeline once and log the result.
 */
export async function runOnce(): Promise<void> {
  const startMs = Date.now();
  logger.info('Scheduled run starting...');

  try {
    await runAll();
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
    logger.info(`Scheduled run completed in ${elapsed}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Scheduled run failed: ${msg}`);
  }
}

/**
 * Start recurring pipeline runs at the given interval (in minutes).
 *
 * The first run starts after the interval (not immediately).
 * Only one interval can be active at a time.
 */
export function startSchedule(intervalMinutes: number): void {
  if (intervalHandle) {
    logger.warn('Schedule already running. Stop it first with stopSchedule().');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  logger.info(`Pipeline scheduled every ${intervalMinutes} minute(s) (${(intervalMs / 1000 / 60).toFixed(0)} min)`);

  // Don't run immediately — wait for the first interval
  intervalHandle = setInterval(() => {
    runOnce().catch((err) => logger.error('Scheduled run error', err));
  }, intervalMs);

  // Allow the process to stay alive
  if (intervalHandle.unref) {
    intervalHandle.unref();
  }
}

/**
 * Stop any active schedule.
 */
export function stopSchedule(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Schedule stopped.');
  }
}

/**
 * Check if a schedule is currently active.
 */
export function isScheduleActive(): boolean {
  return intervalHandle !== null;
}
