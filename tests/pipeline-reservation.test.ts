import { describe, expect, it } from 'vitest';
import { PipelineManager, PipelineStateTracker } from '../src/jobs/pipeline-state';

describe('pipeline reservation', () => {
  it('reserves synchronously and rejects a second launch for the same user', () => {
    const manager = new PipelineManager();

    const first = manager.reserve(101, 1);
    const second = manager.reserve(101, 1);

    expect(first.allowed).toBe(true);
    expect(first.state.snapshot().running).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.state).toBe(first.state);
  });

  it('does not reset an already reserved tracker', () => {
    const tracker = new PipelineStateTracker();
    expect(tracker.startPipeline()).toBe(true);
    tracker.startStage('score', 1);
    tracker.taskStarted('score', 42);

    expect(tracker.startPipeline()).toBe(false);
    expect(tracker.snapshot().stage).toBe('score');
    expect(tracker.snapshot().stages.score.running).toEqual([42]);
  });
});
