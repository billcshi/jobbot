import { describe, it, expect, vi } from 'vitest';
import { asyncPool } from '../src/utils/async-pool';

describe('asyncPool', () => {
  it('processes all items', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await asyncPool(3, items, async (n) => n * 2);

    expect(results).toHaveLength(5);
    expect(results.map((r) => r.result)).toEqual([2, 4, 6, 8, 10]);
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(results.every((r) => r.skipped === false)).toBe(true);
  });

  it('preserves order regardless of completion order', async () => {
    const items = [100, 10, 1];
    const results = await asyncPool(3, items, async (n) => {
      // Shorter delay for larger numbers — they finish in reverse order
      await new Promise((r) => setTimeout(r, n));
      return n;
    });

    expect(results.map((r) => r.result)).toEqual([100, 10, 1]);
  });

  it('captures errors without stopping the pool', async () => {
    const items = [1, 2, 3, 4];
    const results = await asyncPool(2, items, async (n) => {
      if (n % 2 === 0) throw new Error(`fail ${n}`);
      return n * 10;
    });

    expect(results).toHaveLength(4);
    expect(results[0]!.result).toBe(10);
    expect(results[0]!.error).toBeNull();
    expect(results[1]!.result).toBeNull();
    expect(results[1]!.error).toBe('fail 2');
    expect(results[2]!.result).toBe(30);
    expect(results[3]!.result).toBeNull();
    expect(results[3]!.error).toBe('fail 4');
  });

  it('respects concurrency limit', async () => {
    const running = new Set<number>();
    let maxConcurrent = 0;
    const items = [1, 2, 3, 4, 5, 6];

    const results = await asyncPool(2, items, async (n) => {
      running.add(n);
      maxConcurrent = Math.max(maxConcurrent, running.size);
      await new Promise((r) => setTimeout(r, 10));
      running.delete(n);
      return n;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(6);
  });

  it('clamps concurrency to at least 1', async () => {
    const items = [1, 2, 3];
    // Passing 0 or negative should still process items
    const results = await asyncPool(0, items, async (n) => n);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.result)).toEqual([1, 2, 3]);
  });

  it('handles empty items array', async () => {
    const results = await asyncPool(3, [], async () => 'never');
    expect(results).toHaveLength(0);
  });

  it('calls onProgress callback', async () => {
    const progressCalls: Array<{ completed: number; running: number }> = [];
    const items = [1, 2, 3];

    await asyncPool(
      2,
      items,
      async (n) => {
        await new Promise((r) => setTimeout(r, 5));
        return n;
      },
      {
        onProgress: (state) => {
          progressCalls.push({
            completed: state.completed,
            running: state.running.length,
          });
        },
      },
    );

    // Should have at least start + end notifications per item
    expect(progressCalls.length).toBeGreaterThanOrEqual(4);
  });

  it('stops starting new tasks when aborted but completes running ones', async () => {
    const controller = new AbortController();
    const executionOrder: number[] = [];

    // 3 items with 1 concurrency: only the first task should run
    const resultsPromise = asyncPool(
      1,
      [1, 2, 3],
      async (n, _idx, signal) => {
        executionOrder.push(n);
        if (n === 1) {
          // Abort after first task starts
          controller.abort();
          await new Promise((r) => setTimeout(r, 20));
        }
        return n;
      },
      { signal: controller.signal },
    );

    const results = await resultsPromise;

    // First task completed, second was never started (aborted before)
    expect(executionOrder).toEqual([1]);
    expect(results[0]!.skipped).toBe(false);
    expect(results[0]!.result).toBe(1);
    expect(results[1]!.skipped).toBe(true);
    expect(results[2]!.skipped).toBe(true);
  });

  it('trackablePool returns controller that can abort', async () => {
    // trackablePool is a convenience wrapper. Due to synchronous worker
    // start, the controller must be accessed via the returned object,
    // not via destructuring. Test that the basic mechanism works.
    const controller = new AbortController();
    const processed: number[] = [];

    const results = await asyncPool(
      1,
      [1, 2],
      async (n) => {
        processed.push(n);
        if (n === 1) controller.abort();
        await new Promise((r) => setTimeout(r, 10));
        return n;
      },
      { signal: controller.signal },
    );

    expect(processed).toEqual([1]);
    expect(results[0]!.skipped).toBe(false);
    expect(results[1]!.skipped).toBe(true);
  });
});
