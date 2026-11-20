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

const { db, onceStore, threadStore } = await import('@extension/storage');
const { beginOnce, canonicalJson, checkOnce, digest, idempotencyKeyOf, onceNote, pruneOnce, stepFor } =
  await import('../index');
import type { AgentContext } from '../../agent/types';
import type { OnceAsk } from '../index';
import type { OnceRecord } from '@extension/storage';

// What checkOnce hands back once the user was shown a record and approved the card
const approved = (record: OnceRecord): OnceAsk => ({
  state: 'ask',
  repeat: { status: 'started', at: record.startedAt, label: record.label },
  blockKey: record.key,
});

const contextOf = (threadId: string) =>
  ({ taskId: threadId, emitEvent: vi.fn(async () => {}) }) as unknown as AgentContext;

const input = { what: 'tool', scope: 'mail:send_email', label: 'Nex Mail › send_email', parts: ['{"to":"ada"}'] };

beforeEach(async () => {
  await db.doOnce.clear();
});

describe('the key of a step', () => {
  it('hashes the same content the same, whatever the spacing, and keeps none of it', async () => {
    const a = await digest(['mail.example', 'See  you at 10. ']);
    expect(a).toBe(await digest(['mail.example', 'See you at 10.']));
    expect(a).not.toBe(await digest(['mail.example', 'See you at 11.']));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('writes arguments with their keys in order, so the same call always hashes the same', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
  });

  it('belongs to the chat’s current task, or to the chat itself on one from before task ids', async () => {
    const thread = await threadStore.create();
    expect((await stepFor(contextOf(thread.id), input)).taskId).toBe(thread.id);
    await threadStore.update(thread.id, { taskRunId: 'request-7' });
    const step = await stepFor(contextOf(thread.id), input);
    expect(step.taskId).toBe('request-7');
    expect(step.threadId).toBe(thread.id);
  });
});

describe('checking a step', () => {
  it('tells the model once per run, then leaves a second try to the user', async () => {
    const thread = await threadStore.create();
    await threadStore.update(thread.id, { taskRunId: 'request-1', runStartedAt: Date.now() - 10 });
    const context = contextOf(thread.id);
    const step = await stepFor(context, input);
    expect((await checkOnce(context, step)).state).toBe('clear');
    await beginOnce(context, step, null);

    expect((await checkOnce(context, step)).state).toBe('told');
    const second = await checkOnce(context, step);
    expect(second).toMatchObject({ state: 'ask', repeat: { status: 'started', label: 'Nex Mail › send_email' } });

    // A later retry is a new run: it is told again first, instead of going straight to the user
    await new Promise(resolve => setTimeout(resolve, 5));
    await threadStore.update(thread.id, { runStartedAt: Date.now() });
    expect((await checkOnce(context, step)).state).toBe('told');
  });

  it('refuses the loser when two writers start the same step', async () => {
    const context = contextOf('no-such-thread');
    const step = await stepFor(context, input);
    const [a, b] = await Promise.all([beginOnce(context, step, null), beginOnce(context, step, null)]);
    expect(['record' in a, 'record' in b].sort()).toEqual([false, true]);
  });

  it('gives a tool the same key for a cut-off call run again, and a new one once it was done', async () => {
    const context = contextOf('no-such-thread');
    const step = await stepFor(context, input);
    const first = await beginOnce(context, step, null);
    if (!('record' in first)) throw new Error('expected it to start');
    const again = await beginOnce(context, step, approved(first.record));
    if (!('record' in again)) throw new Error('expected it to start again');
    expect(await idempotencyKeyOf(again.record)).toBe(await idempotencyKeyOf(first.record));
    await onceStore.finish(again.record.key, 'the tool answered');
    const redone = await beginOnce(context, step, approved(again.record));
    if (!('record' in redone)) throw new Error('expected it to start');
    expect(await idempotencyKeyOf(redone.record)).not.toBe(await idempotencyKeyOf(first.record));
  });
});

describe('a retried run that sends on the same site or tool again', () => {
  it('goes straight to the user with a note, without sending the model away: only the user can tell a repeat', async () => {
    const thread = await threadStore.create();
    await threadStore.update(thread.id, { taskRunId: 'request-3', runStartedAt: Date.now() - 10 });
    const context = contextOf(thread.id);
    const sent = await beginOnce(context, await stepFor(context, input), null);
    if (!('record' in sent)) throw new Error('expected it to start');
    await onceStore.finish(sent.record.key, 'the tool answered');

    // The same run sends another, different email: nothing in its way
    const next = await stepFor(context, { ...input, parts: ['{"to":"tomi"}'] });
    expect((await checkOnce(context, next)).state).toBe('clear');

    // The task is retried. The model words the first email differently, so its hash is new.
    await new Promise(resolve => setTimeout(resolve, 5));
    await threadStore.update(thread.id, { runStartedAt: Date.now() });
    const reworded = await stepFor(context, { ...input, parts: ['{"to":"ada","body":"Hello again"}'] });
    expect(await checkOnce(context, reworded)).toMatchObject({
      state: 'ask',
      repeat: { status: 'earlier', label: 'Nex Mail › send_email' },
      blockKey: sent.record.key,
    });
    // Without the user's click it is not started
    expect('result' in (await beginOnce(context, reworded, null))).toBe(true);
  });
});

describe('when the records cannot be read', () => {
  it('refuses the step instead of running it without a check', async () => {
    const read = vi.spyOn(threadStore, 'get').mockRejectedValue(new Error('database is closed'));
    try {
      await expect(stepFor(contextOf('any-thread'), input)).rejects.toThrow('database is closed');
    } finally {
      read.mockRestore();
    }
  });
});

describe('what a resumed run is told', () => {
  it('says nothing for a task that has sent nothing', async () => {
    expect(await onceNote({ id: 'chat-none', taskRunId: 'request-none' })).toBe('');
    expect(await onceNote({ id: 'chat-none', taskRunId: null })).toBe('');
  });

  it('lists what is done and what was cut off, and leaves out what failed', async () => {
    const step = { taskId: 'request-2', threadId: 't', what: 'tool' };
    const done = await onceStore.begin({ ...step, target: 'a', scope: 's1', label: 'Nex Mail › send_email' });
    await onceStore.finish(done.record.key, 'ok');
    const failed = await onceStore.begin({ ...step, target: 'b', scope: 's2', label: 'Slack › post_message' });
    await onceStore.fail(failed.record.key, 'forbidden');
    await onceStore.begin({ ...step, target: 'c', scope: 's3', label: 'send on mail.example' });
    const note = await onceNote({ id: 't', taskRunId: 'request-2' });
    expect(note).toContain('do not do these again:\n- Nex Mail › send_email');
    expect(note).toContain("never repeat one without the user's click:\n- send on mail.example");
    expect(note).not.toContain('Slack');
  });
});

describe('old records', () => {
  it('are dropped after 90 days', async () => {
    const fresh = await onceStore.begin({
      taskId: 'x',
      threadId: 't',
      what: 'tool',
      target: 'a',
      scope: 's',
      label: 'l',
    });
    const old = await onceStore.begin({
      taskId: 'y',
      threadId: 'u',
      what: 'tool',
      target: 'b',
      scope: 's',
      label: 'l',
    });
    await db.doOnce.update(old.record.key, { startedAt: Date.now() - 91 * 24 * 60 * 60 * 1000 });
    await pruneOnce();
    expect((await db.doOnce.toArray()).map(record => record.key)).toEqual([fresh.record.key]);
  });
});
