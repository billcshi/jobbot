/**
 * Scheduled Pipeline Runs
 *
 * Simple interval-based pipeline scheduling. Uses `setInterval` when running
 * inside the UI server process, or a one-shot mode for CLI use.
 *
 * CLI:
 *   pnpm jobbot schedule --interval <minutes>   recurring
 *   pnpm jobbot schedule --once                  run once and exit
 */

import { runAllForContext } from './run.js';
import { getPipelineManager } from './pipeline-state.js';
import type { AppContext } from '../utils/app-context.js';
import { logger } from '../utils/logger.js';

interface ScheduleState {
  readonly context: AppContext;
  readonly intervalHandle: ReturnType<typeof setInterval>;
}

/** One independently controllable interval per explicitly selected user. */
const schedules = new Map<number, ScheduleState>();

/** Includes ticks that are still finishing after their schedule was stopped. */
const inFlightUsers = new Set<number>();

/**
 * Run the pipeline once and log the result.
 */
export async function runOnce(context: AppContext): Promise<void> {
  const startMs = Date.now();
  const manager = getPipelineManager();
  const reservation = manager.reserve(context.userId, Number.MAX_SAFE_INTEGER);
  if (!reservation.allowed) {
    logger.warn(`Scheduled run skipped for user ${context.userId}: ${reservation.reason ?? 'pipeline unavailable'}`);
    return;
  }

  logger.info(`Scheduled run starting for user ${context.userId}...`);

  try {
    await runAllForContext(context, reservation.state, reservation.concurrency);
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
    logger.info(`Scheduled run completed for user ${context.userId} in ${elapsed}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Scheduled run failed for user ${context.userId}: ${msg}`);
  } finally {
    // The pipeline service also finishes its tracker. This guarantees a failed
    // launch cannot leave the reservation stuck before the service starts.
    reservation.state.finishPipeline();
  }
}

async function runScheduledTick(context: AppContext): Promise<void> {
  if (inFlightUsers.has(context.userId)) {
    logger.warn(`Scheduled tick skipped for user ${context.userId}: previous tick is still running.`);
    return;
  }

  inFlightUsers.add(context.userId);
  try {
    await runOnce(context);
  } finally {
    inFlightUsers.delete(context.userId);
  }
}

/**
 * Start recurring pipeline runs at the given interval (in minutes).
 *
 * The first run starts after the interval (not immediately).
 * Each user can have one interval, independently of every other user.
 */
export function startSchedule(intervalMinutes: number, context: AppContext): boolean {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
    throw new Error('Schedule interval must be at least one minute.');
  }
  if (schedules.has(context.userId)) {
    logger.warn(`Schedule already running for user ${context.userId}.`);
    return false;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  logger.info(`Pipeline scheduled for user ${context.userId} every ${intervalMinutes} minute(s) (${(intervalMs / 1000 / 60).toFixed(0)} min)`);

  // Don't run immediately — wait for the first interval
  const capturedContext: AppContext = { ...context };
  const intervalHandle = setInterval(() => {
    void runScheduledTick(capturedContext).catch((err: unknown) => logger.error('Scheduled run error', err));
  }, intervalMs);
  schedules.set(context.userId, { context: capturedContext, intervalHandle });

  // Allow the process to stay alive
  if (intervalHandle.unref) {
    intervalHandle.unref();
  }
  return true;
}

/**
 * Stop any active schedule.
 */
export function stopSchedule(userId: number): boolean {
  const schedule = schedules.get(userId);
  if (!schedule) return false;
  clearInterval(schedule.intervalHandle);
  schedules.delete(userId);
  logger.info(`Schedule stopped for user ${userId}.`);
  return true;
}

/**
 * Check if a schedule is currently active.
 */
export function isScheduleActive(userId: number): boolean {
  return schedules.has(userId);
}
