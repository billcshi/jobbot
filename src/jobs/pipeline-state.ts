/**
 * Pipeline state tracker — a singleton that records the progress of
 * the currently-running pipeline batch so both the CLI and web UI
 * can inspect and control it.
 *
 * Web UI polls `GET /api/pipeline/status` to render live progress.
 * `POST /api/pipeline/cancel` aborts the current pipeline.
 * `POST /api/pipeline/tasks/:jobId/cancel` cancels a single task.
 *
 * Each task has its own AbortController, metadata, and cancellation state.
 */

import { getConcurrency } from '../utils/config.js';

export type PipelineStage = 'extract' | 'score' | 'compose' | 'audit';

export interface TaskInfo {
  jobId: number;
  startedAt: string;
  /** Optional metadata set by the stage runner for richer UI display. */
  title?: string;
  company?: string;
}

export interface StageState {
  total: number;
  running: Map<number, TaskInfo>;
  completed: Set<number>;
  failed: Set<number>;
  /** Task cancelled by the user (distinct from failed/errored). */
  cancelled: Set<number>;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PipelineSnapshot {
  running: boolean;
  stage: PipelineStage | null;
  stages: Record<PipelineStage, {
    total: number;
    running: number[];
    /** Running task details: jobId, title, company, elapsed seconds. */
    runningDetails: Array<{ jobId: number; title?: string; company?: string; elapsedSec: number }>;
    completed: number[];
    failed: number[];
    cancelled: number[];
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  startedAt: string | null;
  finishedAt: string | null;
}

function emptyStage(): StageState {
  return {
    total: 0,
    running: new Map(),
    completed: new Set(),
    failed: new Set(),
    cancelled: new Set(),
    startedAt: null,
    finishedAt: null,
  };
}

export class PipelineStateTracker {
  running = false;
  currentStage: PipelineStage | null = null;
  stages: Record<PipelineStage, StageState> = {
    extract: emptyStage(),
    score: emptyStage(),
    compose: emptyStage(),
    audit: emptyStage(),
  };
  startedAt: string | null = null;
  finishedAt: string | null = null;
  abortController: AbortController | null = null;

  // Per-task abort controllers for individual cancellation
  // Key: "${stage}:${jobId}"
  taskControllers: Map<string, AbortController> = new Map();

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Start or reserve this tracker. Returns false when it was already reserved.
   * Crucially, an already-running tracker is never reset by a later service
   * call; this closes the check-then-start race in HTTP background launches.
   */
  startPipeline(): boolean {
    if (this.running) return false;
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.currentStage = null;
    this.stages = {
      extract: emptyStage(),
      score: emptyStage(),
      compose: emptyStage(),
      audit: emptyStage(),
    };
    this.abortController = new AbortController();
    this.taskControllers.clear();
    return true;
  }

  finishPipeline(): void {
    this.running = false;
    this.finishedAt = new Date().toISOString();
    this.currentStage = null;
    this.abortController = null;
    // Don't abort remaining controllers — tasks may still be finishing.
    // Individual task controllers are cleaned up by taskCompleted/taskFailed/taskCancelled.
    this.taskControllers.clear();
  }

  startStage(stage: PipelineStage, total: number): void {
    this.currentStage = stage;
    this.stages[stage] = {
      total,
      running: new Map(),
      completed: new Set(),
      failed: new Set(),
      cancelled: new Set(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
  }

  finishStage(stage: PipelineStage): void {
    this.stages[stage].finishedAt = new Date().toISOString();
    this.currentStage = null;
  }

  /**
   * Record a task as started. Optionally attaches metadata for UI display.
   * Creates a per-task AbortController so the task can be individually cancelled.
   *
   * @returns The per-task AbortController — callers combine this with the
   *          global pipeline signal for a combined abort source.
   */
  taskStarted(
    stage: PipelineStage,
    jobId: number,
    meta?: { title?: string; company?: string },
  ): AbortController {
    const info: TaskInfo = {
      jobId,
      startedAt: new Date().toISOString(),
      title: meta?.title,
      company: meta?.company,
    };
    this.stages[stage].running.set(jobId, info);
    // Create per-task controller
    const ctrl = new AbortController();
    this.taskControllers.set(`${stage}:${jobId}`, ctrl);
    // If the global pipeline was already cancelled, abort this task immediately
    if (this.abortController?.signal.aborted) {
      ctrl.abort();
    }
    return ctrl;
  }

  taskCompleted(stage: PipelineStage, jobId: number): void {
    this.stages[stage].running.delete(jobId);
    this.stages[stage].completed.add(jobId);
    this.taskControllers.delete(`${stage}:${jobId}`);
  }

  taskFailed(stage: PipelineStage, jobId: number): void {
    this.stages[stage].running.delete(jobId);
    this.stages[stage].failed.add(jobId);
    this.taskControllers.delete(`${stage}:${jobId}`);
  }

  /** Mark a task as explicitly cancelled (not a natural failure). */
  taskCancelled(stage: PipelineStage, jobId: number): void {
    this.stages[stage].running.delete(jobId);
    this.stages[stage].cancelled.add(jobId);
    this.taskControllers.delete(`${stage}:${jobId}`);
  }

  /** Update metadata for a running task (e.g., after extraction reveals title/company). */
  updateTaskMeta(
    stage: PipelineStage,
    jobId: number,
    meta: { title?: string; company?: string },
  ): void {
    const info = this.stages[stage].running.get(jobId);
    if (info) {
      if (meta.title !== undefined) info.title = meta.title;
      if (meta.company !== undefined) info.company = meta.company;
    }
  }

  // ---- control --------------------------------------------------------------

  /** Cancel the entire pipeline. Aborts the global signal + all per-task controllers. */
  cancel(): boolean {
    if (!this.abortController) return false;
    this.abortController.abort();
    // Also abort all per-task controllers so individual tasks stop immediately
    for (const ctrl of this.taskControllers.values()) {
      try { ctrl.abort(); } catch { /* already aborted */ }
    }
    return true;
  }

  /**
   * Cancel a single running task. The task's AbortSignal will fire,
   * causing the in-flight fetch to throw an AbortError. The stage runner
   * catches this and marks the task as cancelled.
   */
  cancelTask(stage: PipelineStage, jobId: number): boolean {
    const key = `${stage}:${jobId}`;
    const ctrl = this.taskControllers.get(key);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /** Returns the global pipeline AbortSignal (for asyncPool). */
  get signal(): AbortSignal | null {
    return this.abortController?.signal ?? null;
  }

  /**
   * Returns a combined AbortSignal that fires when EITHER the global
   * pipeline is cancelled OR the individual task is cancelled.
   *
   * Use `AbortSignal.any()` when available (Node 20+), otherwise
   * fall back to the global signal alone.
   */
  getCombinedSignal(stage: PipelineStage, jobId: number): AbortSignal {
    const signals: AbortSignal[] = [];
    if (this.abortController) signals.push(this.abortController.signal);
    const taskCtrl = this.taskControllers.get(`${stage}:${jobId}`);
    if (taskCtrl) signals.push(taskCtrl.signal);
    if (signals.length === 1) return signals[0]!;
    // AbortSignal.any is available in Node 20+
    if (typeof (AbortSignal as any).any === 'function') {
      return (AbortSignal as any).any(signals);
    }
    // Fallback: return the first signal (per-task if available, else global)
    return signals[signals.length - 1]!;
  }

  // ---- snapshot -------------------------------------------------------------

  /** Return a JSON-safe snapshot for the web UI. */
  snapshot(): PipelineSnapshot {
    const now = Date.now();
    const stageSnapshots: PipelineSnapshot['stages'] = {} as PipelineSnapshot['stages'];
    for (const key of ['extract', 'score', 'compose', 'audit'] as PipelineStage[]) {
      const s = this.stages[key];
      const runningDetails: PipelineSnapshot['stages']['extract']['runningDetails'] = [];
      for (const info of s.running.values()) {
        const elapsedSec = Math.floor((now - new Date(info.startedAt).getTime()) / 1000);
        runningDetails.push({
          jobId: info.jobId,
          title: info.title,
          company: info.company,
          elapsedSec,
        });
      }
      stageSnapshots[key] = {
        total: s.total,
        running: [...s.running.keys()].sort((a, b) => a - b),
        runningDetails,
        completed: [...s.completed].sort((a, b) => a - b),
        failed: [...s.failed].sort((a, b) => a - b),
        cancelled: [...s.cancelled].sort((a, b) => a - b),
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
      };
    }

    return {
      running: this.running,
      stage: this.currentStage,
      stages: stageSnapshots,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }
}

// ---- singleton (CLI backward compat) ----------------------------------------

let instance: PipelineStateTracker | null = null;

/** Get (or create) the global pipeline state tracker. For CLI use only. */
export function getPipelineState(): PipelineStateTracker {
  if (!instance) {
    instance = new PipelineStateTracker();
  }
  return instance;
}

// ---- per-user pipeline manager (web server) ----------------------------------

/**
 * Manages per-user PipelineStateTracker instances.
 * Each user gets an independent pipeline — they can run, cancel,
 * and inspect their own pipeline without affecting other users.
 */
export interface PipelineReservation {
  allowed: boolean;
  state: PipelineStateTracker;
  concurrency: number;
  reason?: string;
}

export class PipelineManager {
  private trackers: Map<number, PipelineStateTracker> = new Map();

  /** Get (or create) the pipeline tracker for a given user. */
  get(userId: number): PipelineStateTracker {
    let tracker = this.trackers.get(userId);
    if (!tracker) {
      tracker = new PipelineStateTracker();
      this.trackers.set(userId, tracker);
    }
    return tracker;
  }

  /**
   * Atomically check capacity and mark a user's tracker running.
   * JavaScript executes this synchronous method without an await boundary, so
   * two HTTP requests cannot both observe an idle tracker and both win.
   */
  reserve(userId: number, jobCount = 1): PipelineReservation {
    const state = this.get(userId);
    if (state.snapshot().running) {
      return {
        allowed: false,
        state,
        concurrency: 0,
        reason: 'Your pipeline is already running. Wait for it to finish or cancel it.',
      };
    }
    const capacity = this.checkCapacity(userId, Math.max(1, jobCount));
    if (!capacity.allowed) return { ...capacity, state };
    if (!state.startPipeline()) {
      return { allowed: false, state, concurrency: 0, reason: 'Your pipeline is already running.' };
    }
    return { allowed: true, state, concurrency: capacity.concurrency };
  }

  /**
   * Check if starting a new pipeline for a user would exceed the global
   * concurrency limit. Returns the effective per-user concurrency
   * (may be reduced if global capacity is constrained), or 0 if blocked.
   */
  checkCapacity(userId: number, jobCount: number): { allowed: boolean; concurrency: number; reason?: string } {
    const c = getConcurrency();
    const active = this.activeUsers().filter((id) => id !== userId);
    const activeCount = active.length;

    // Each active user consumes up to per_user concurrent tasks
    const perUser = c.per_user;
    const globalCap = c.global;

    // Estimate current load: each active user with a running pipeline
    // could be using up to per_user slots
    const estimatedLoad = activeCount * perUser;
    const available = globalCap - estimatedLoad;

    if (available <= 0) {
      return {
        allowed: false,
        concurrency: 0,
        reason: `Global concurrency limit reached (${globalCap}). ${activeCount} user(s) already running. Wait for one to finish.`,
      };
    }

    // Cap this user's concurrency to the available global capacity
    const effectiveConcurrency = Math.min(perUser, available, jobCount);
    return { allowed: true, concurrency: Math.max(1, effectiveConcurrency) };
  }

  /** Check if a user has a running pipeline. */
  isRunning(userId: number): boolean {
    const tracker = this.trackers.get(userId);
    return tracker ? tracker.snapshot().running : false;
  }

  /** Remove a user's tracker after pipeline completes (optional cleanup). */
  remove(userId: number): void {
    this.trackers.delete(userId);
  }

  /** List all users with active pipelines. */
  activeUsers(): number[] {
    const active: number[] = [];
    for (const [userId, tracker] of this.trackers) {
      if (tracker.snapshot().running) active.push(userId);
    }
    return active;
  }
}

let pipelineManager: PipelineManager | null = null;

/** Get (or create) the global per-user pipeline manager. For web server use. */
export function getPipelineManager(): PipelineManager {
  if (!pipelineManager) {
    pipelineManager = new PipelineManager();
  }
  return pipelineManager;
}
