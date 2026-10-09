import { describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest } from '@extension/storage';
import { ConfirmGate } from '../confirmGate';

const request = (id: string): ConfirmRequest => ({
  id,
  taskId: 'task',
  mode: 'commit',
  kind: 'send',
  intent: 'Send the message',
  target: 'Send',
  pageTitle: 'Chat',
  pageUrl: 'https://chat.example/',
  fields: [{ label: 'Message', value: 'hello' }],
  context: '',
});

const show = () => vi.fn(async () => {});

describe('ConfirmGate', () => {
  it('waits until the user answers', async () => {
    const gate = new ConfirmGate();
    const shown = show();
    let settled = false;
    const answer = gate.ask(request('a'), shown).then(value => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    expect(shown).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(gate.pendingCount).toBe(1);

    expect(gate.answer('a', true)).toBe(true);
    expect(await answer).toBe('approved');
    expect(gate.pendingCount).toBe(0);
  });

  it('reports a refusal', async () => {
    const gate = new ConfirmGate();
    const answer = gate.ask(request('a'), show());
    gate.answer('a', false);
    expect(await answer).toBe('declined');
  });

  it('ignores an answer to a request that is not waiting', async () => {
    const gate = new ConfirmGate();
    expect(gate.answer('missing', true)).toBe(false);

    const answer = gate.ask(request('a'), show());
    expect(gate.answer('b', true)).toBe(false);
    gate.answer('a', false);
    // A second answer cannot turn a refusal into an approval
    expect(gate.answer('a', true)).toBe(false);
    expect(await answer).toBe('declined');
  });

  it('never approves a request when the task is stopped', async () => {
    const gate = new ConfirmGate();
    const first = gate.ask(request('a'), show());
    const second = gate.ask(request('b'), show());
    gate.cancelAll();
    expect(await first).toBe('cancelled');
    expect(await second).toBe('cancelled');
    expect(gate.answer('a', true)).toBe(false);
  });

  it('cancels when the task is aborted while waiting', async () => {
    const gate = new ConfirmGate();
    const controller = new AbortController();
    const answer = gate.ask(request('a'), show(), controller.signal);
    controller.abort();
    expect(await answer).toBe('cancelled');
  });

  it('does not show a request for a task that is already aborted', async () => {
    const gate = new ConfirmGate();
    const controller = new AbortController();
    controller.abort();
    const shown = show();
    expect(await gate.ask(request('a'), shown, controller.signal)).toBe('cancelled');
    expect(shown).not.toHaveBeenCalled();
  });

  it('closes a request that could not be shown', async () => {
    const gate = new ConfirmGate();
    const failing = vi.fn(async () => {
      throw new Error('panel closed');
    });
    await expect(gate.ask(request('a'), failing)).rejects.toThrow('panel closed');
    expect(gate.pendingCount).toBe(0);
    expect(gate.answer('a', true)).toBe(false);
  });

  it('hands the typed answers to the asker once, and only with an approval', async () => {
    const gate = new ConfirmGate();
    const asked = gate.ask(request('q'), async () => {});
    expect(gate.answer('q', true, ['1 May 1990', ''])).toBe(true);
    expect(await asked).toBe('approved');
    expect(gate.takeReplies('q')).toEqual(['1 May 1990', '']);
    expect(gate.takeReplies('q')).toEqual([]);

    const skipped = gate.ask(request('s'), async () => {});
    gate.answer('s', false, ['ignored']);
    expect(await skipped).toBe('declined');
    expect(gate.takeReplies('s')).toEqual([]);
  });
});
