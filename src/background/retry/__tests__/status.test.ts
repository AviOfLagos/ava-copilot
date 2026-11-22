import { describe, expect, it, vi } from 'vitest';
import { Actors, AgentEvent, ExecutionState } from '../../agent/event/types';
import { effectOf } from '../../threads/transcript';
import { decodeRetryStatus, encodeRetryStatus, whileRetrying } from '../status';
import type { RetryStatus } from '../status';

describe('retry status', () => {
  it('round-trips through the event details', () => {
    const status: RetryStatus = { kind: 'step', until: 5000, attempt: 2, max: 3 };
    expect(decodeRetryStatus(encodeRetryStatus(status))).toEqual(status);
    expect(decodeRetryStatus(encodeRetryStatus({ kind: 'repair' }))).toEqual({ kind: 'repair' });
  });

  it('reads empty or broken details as "no retry"', () => {
    expect(decodeRetryStatus('')).toBeNull();
    expect(decodeRetryStatus('{nope')).toBeNull();
    expect(decodeRetryStatus('{"kind":"coffee"}')).toBeNull();
    expect(decodeRetryStatus('null')).toBeNull();
  });

  it('shows the status for the wait and clears it after, also when the wait throws', async () => {
    const report = vi.fn();
    await whileRetrying(report, { kind: 'repair' }, async () => 1);
    expect(report.mock.calls).toEqual([[{ kind: 'repair' }], [null]]);

    const failing = vi.fn();
    await expect(
      whileRetrying(failing, { kind: 'model' }, async () => {
        throw new Error('stopped');
      }),
    ).rejects.toThrow('stopped');
    expect(failing).toHaveBeenLastCalledWith(null);
  });

  it('runs the wait without a reporter', async () => {
    await expect(whileRetrying(undefined, { kind: 'step' }, async () => 'ok')).resolves.toBe('ok');
  });

  it('turns a retry event into a thread state, and the end of the task clears it', () => {
    const event = (state: ExecutionState, details: string) =>
      new AgentEvent(Actors.SYSTEM, state, { taskId: 't', step: 1, maxSteps: 5, details });
    const status: RetryStatus = { kind: 'step', until: 9000, attempt: 1, max: 3 };
    expect(effectOf(event(ExecutionState.ACT_RETRY, encodeRetryStatus(status)))).toEqual({ retrying: status });
    expect(effectOf(event(ExecutionState.ACT_RETRY, ''))).toEqual({ retrying: null });
    expect(effectOf(event(ExecutionState.TASK_OK, '')).retrying).toBeNull();
    expect(effectOf(event(ExecutionState.TASK_FAIL, 'boom')).retrying).toBeNull();
    // A retry is never a chat message
    expect(effectOf(event(ExecutionState.ACT_RETRY, encodeRetryStatus(status))).message).toBeUndefined();
  });
});
