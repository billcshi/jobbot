import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/utils/app-context';

const { runAllForContext } = vi.hoisted(() => ({
  runAllForContext: vi.fn(),
}));

vi.mock('../src/jobs/run.js', () => ({ runAllForContext }));

import {
  isScheduleActive,
  startSchedule,
  stopSchedule,
} from '../src/jobs/schedule';

const userA: AppContext = { userId: 101, profileId: 1001, profileName: 'user-a' };
const userB: AppContext = { userId: 202, profileId: 2002, profileName: 'user-b' };

describe('per-user pipeline schedules', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runAllForContext.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopSchedule(userA.userId);
    stopSchedule(userB.userId);
    vi.useRealTimers();
  });

  it('starts and stops schedules independently with their captured contexts', async () => {
    expect(startSchedule(1, userA)).toBe(true);
    expect(startSchedule(1, userB)).toBe(true);
    expect(startSchedule(1, userA)).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(runAllForContext).toHaveBeenCalledTimes(2);
    expect(runAllForContext.mock.calls.map(([context]) => context)).toEqual(
      expect.arrayContaining([userA, userB]),
    );

    expect(stopSchedule(userA.userId)).toBe(true);
    expect(isScheduleActive(userA.userId)).toBe(false);
    expect(isScheduleActive(userB.userId)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(runAllForContext).toHaveBeenCalledTimes(3);
    expect(runAllForContext.mock.calls[2]?.[0]).toEqual(userB);
  });

  it('skips an interval tick while the same user tick is still running', async () => {
    let finishFirstRun: (() => void) | undefined;
    runAllForContext.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    }));
    expect(startSchedule(1, userA)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runAllForContext).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runAllForContext).toHaveBeenCalledTimes(1);

    finishFirstRun?.();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runAllForContext).toHaveBeenCalledTimes(2);
  });
});
