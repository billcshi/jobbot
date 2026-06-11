/**
 * Generic async pool — runs up to `concurrency` async tasks in parallel,
 * starting a new one each time one finishes (sliding window).
 *
 * Results are returned in the same order as `items`. Individual task
 * failures do NOT stop the pool — errored tasks capture the error so
 * the caller can inspect and handle failures.
 *
 * Supports cancellation via AbortSignal — when aborted, no new tasks
 * are started and already-running tasks receive the signal.
 */

export interface AsyncPoolResult<T> {
  /** The original item passed to the pool. */
  item: T;
  /** The resolved value, or null if the task threw or was skipped. */
  result: unknown;
  /** Error message if the task threw, null otherwise. */
  error: string | null;
  /** True if this task was skipped due to abort. */
  skipped: boolean;
}

/** Live state of a running pool. Can be inspected for progress reporting. */
export interface PoolState {
  /** Total number of items to process. */
  total: number;
  /** Items currently being processed (their indices). */
  running: number[];
  /** Number of items completed (success or error). */
  completed: number;
  /** Number of items skipped due to abort. */
  skipped: number;
  /** Whether the pool has been aborted. */
  aborted: boolean;
}

export interface AsyncPoolOptions {
  /**
   * Callback invoked each time a task starts or finishes.
   * Useful for logging progress in real time.
   */
  onProgress?: (state: Readonly<PoolState>) => void;
  /**
   * AbortSignal — when aborted, the pool stops starting new tasks.
   * Already-running tasks receive the signal via `fn`'s third argument
   * and should handle it gracefully (e.g., by throwing or returning early).
   */
  signal?: AbortSignal;
  /**
   * Optional label for this pool (used in progress logs).
   */
  label?: string;
}

/**
 * Run `fn` over `items` with bounded concurrency.
 *
 * @param concurrency  Max concurrent tasks (clamped to ≥1).
 * @param items        Array of items to process.
 * @param fn           Async function called for each item: (item, index, signal).
 *                     The signal is the pool's AbortSignal (or an always-live signal).
 * @param opts         Optional progress callback and AbortSignal.
 * @returns            Array of {@link AsyncPoolResult} in the same order as `items`.
 */
export async function asyncPool<T>(
  concurrency: number,
  items: T[],
  fn: (item: T, index: number, signal: AbortSignal) => Promise<unknown>,
  opts?: AsyncPoolOptions,
): Promise<AsyncPoolResult<T>[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: AsyncPoolResult<T>[] = new Array(items.length);
  const signal = opts?.signal ?? new AbortController().signal;
  const onProgress = opts?.onProgress;

  const running = new Set<number>();
  let nextIndex = 0;
  let completed = 0;
  let skipped = 0;
  let aborted = false;

  // Listen for external abort
  const onAbort = () => { aborted = true; };
  signal.addEventListener('abort', onAbort, { once: true });

  function snapshot(): PoolState {
    return {
      total: items.length,
      running: [...running].sort((a, b) => a - b),
      completed,
      skipped,
      aborted,
    };
  }

  function notify(): void {
    if (onProgress) {
      try { onProgress(snapshot()); } catch { /* swallow */ }
    }
  }

  async function worker(): Promise<void> {
    while (nextIndex < items.length && !signal.aborted) {
      const idx = nextIndex++;
      const item = items[idx]!;

      running.add(idx);
      notify();

      try {
        const result = await fn(item, idx, signal);
        results[idx] = { item, result, error: null, skipped: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results[idx] = { item, result: null, error: msg, skipped: false };
      } finally {
        running.delete(idx);
        completed++;
        notify();
      }
    }
  }

  // Start workers
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  // Any remaining items that were never started are "skipped"
  for (let i = 0; i < items.length; i++) {
    if (!results[i]) {
      results[i] = { item: items[i]!, result: null, error: null, skipped: true };
      skipped++;
    }
  }

  signal.removeEventListener('abort', onAbort);

  // Final progress notification
  notify();

  return results;
}

/**
 * Create an AbortController and return it along with a matching asyncPool
 * runner. The caller holds `controller` to inspect state or call `.abort()`.
 *
 * NOTE: The controller is wrapped in an object to avoid the TDZ (Temporal
 * Dead Zone) trap — destructuring `{ controller, pool }` would make
 * `controller` inaccessible inside `fn` because the destructuring hasn't
 * completed when the async pool starts running.
 *
 * Usage:
 * ```ts
 * const tracked = trackablePool(3, jobs, async (job, i, sig) => {
 *   // ... work ...
 * });
 * // Later: tracked.controller.abort();
 * const results = await tracked.pool;
 * ```
 */
export function trackablePool<T>(
  concurrency: number,
  items: T[],
  fn: (item: T, index: number, signal: AbortSignal) => Promise<unknown>,
  opts?: Omit<AsyncPoolOptions, 'signal'>,
): { controller: AbortController; pool: Promise<AsyncPoolResult<T>[]> } {
  // Use an object wrapper so the controller is accessible even when
  // the return value is destructured (avoids TDZ in fn).
  const ctrl: { controller: AbortController } = { controller: new AbortController() };
  const pool = asyncPool(concurrency, items, fn, { ...opts, signal: ctrl.controller.signal });
  return { controller: ctrl.controller, pool };
}
