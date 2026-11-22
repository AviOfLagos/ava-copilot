import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(data, items),
        onChanged: { addListener: () => undefined },
      },
    },
    i18n: { getMessage: (key: string) => key },
  });
});

const { db, threadStore } = await import('@extension/storage');
const { didNotHappen, guardOnce } = await import('../guard');
const { ConfirmGate } = await import('../../gate/confirmGate');
const { ExecutionState } = await import('../../agent/event/types');
import type { ConfirmRequest } from '@extension/storage';
import type { OnceContext } from '../guard';

/** Do-once keys for the actions that start a run in the background (issue #84). */

const input = { what: 'agent.run', scope: 'agent:a1', label: 'run the agent "Research"', parts: ['a1', 'look into X'] };
const card = { kind: 'submit' as const, intent: 'Run it again', target: 'Research', fields: [] };

async function task() {
  const thread = await threadStore.create();
  await threadStore.update(thread.id, { taskRunId: 'request-1', runStartedAt: Date.now() - 10 });
  return thread.id;
}

/** A task whose user answers every card the way `answer` says. */
function context(threadId: string, answer: 'approve' | 'decline') {
  const confirmGate = new ConfirmGate();
  const cards: ConfirmRequest[] = [];
  let stopped = false;
  const value = {
    taskId: threadId,
    confirmGate,
    controller: new AbortController(),
    stop: async () => void (stopped = true),
    emitEvent: async (_actor: unknown, state: string, details: string) => {
      if (state !== ExecutionState.ACT_CONFIRM) return;
      const request = JSON.parse(details) as ConfirmRequest;
      cards.push(request);
      setTimeout(() => confirmGate.answer(request.id, answer === 'approve'));
    },
  } as unknown as OnceContext;
  return { value, cards, stopped: () => stopped };
}

beforeEach(async () => {
  await db.doOnce.clear();
});

describe('guardOnce', () => {
  it('lets the first run start and tells the model about a retry that would start it again', async () => {
    const threadId = await task();
    const first = await guardOnce(context(threadId, 'decline').value, input, card);
    expect('start' in first).toBe(true);
    if ('start' in first) await first.start.done('the run started');

    const retry = context(threadId, 'decline');
    const second = await guardOnce(retry.value, input, card);
    expect('result' in second && second.result.error).toMatch(/Already done in this task/);
    expect(retry.cards).toHaveLength(0);
  });

  it('a retry after a cut-off start goes to the user, and only their click starts it again', async () => {
    const threadId = await task();
    // Started, never settled: the background died before the run was recorded
    await guardOnce(context(threadId, 'decline').value, input, card);
    const told = await guardOnce(context(threadId, 'decline').value, input, card);
    expect('result' in told && told.result.error).toMatch(/not known whether it went through/);

    const declined = context(threadId, 'decline');
    const refused = await guardOnce(declined.value, input, card);
    expect(declined.cards[0]!.repeat).toMatchObject({ status: 'started' });
    expect('result' in refused && refused.result.error).toMatch(/did not approve/);
    expect(declined.stopped()).toBe(true);

    const approved = context(threadId, 'approve');
    expect('start' in (await guardOnce(approved.value, input, card))).toBe(true);
    expect(approved.cards).toHaveLength(1);
  });

  it('a run refused before it began can be tried again without a card', async () => {
    const threadId = await task();
    const first = await guardOnce(context(threadId, 'decline').value, input, card);
    if ('start' in first) await first.start.failed('budget');
    const again = context(threadId, 'decline');
    expect('start' in (await guardOnce(again.value, input, card))).toBe(true);
    expect(again.cards).toHaveLength(0);
  });

  it('other words or another agent are another step', async () => {
    const threadId = await task();
    const first = await guardOnce(context(threadId, 'decline').value, input, card);
    if ('start' in first) await first.start.done('ok');
    const other = await guardOnce(
      context(threadId, 'decline').value,
      { ...input, parts: ['a1', 'something else'] },
      card,
    );
    expect('start' in other).toBe(true);
  });
});

describe('didNotHappen', () => {
  it('counts refusals as not started and a cut-off as maybe started', () => {
    expect(didNotHappen('budget')).toBe(true);
    expect(didNotHappen('invalid')).toBe(true);
    expect(didNotHappen('timeout')).toBe(false);
    expect(didNotHappen('network')).toBe(false);
  });
});
