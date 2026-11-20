import 'fake-indexeddb/auto';
import { Dexie } from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '../../threads/db';
import { createThreadStore } from '../../threads/threads';
import { createOnceStore, onceKey } from '../index';
import type { OnceStep, OnceStore } from '../index';

let db: AviCopilotDb;
let once: OnceStore;

const step = (fields: Partial<OnceStep> = {}): OnceStep => ({
  taskId: 'task-1',
  threadId: 'thread-1',
  what: 'tool',
  target: 'hash-a',
  scope: 'mail:send_email',
  label: 'Nex Mail › send_email',
  ...fields,
});

beforeEach(() => {
  db = new AviCopilotDb(`once-${crypto.randomUUID()}`);
  once = createOnceStore(db);
});

describe('do-once records', () => {
  it('starts a step once: the second writer is told it already exists', async () => {
    const first = await once.begin(step());
    const second = await once.begin(step());
    expect(first.fresh).toBe(true);
    expect(first.record.status).toBe('started');
    expect(second.fresh).toBe(false);
    expect(second.record.key).toBe(onceKey(step()));
  });

  it('lets exactly one of two writers at the same moment start the step', async () => {
    const claims = await Promise.all(Array.from({ length: 8 }, () => once.begin(step())));
    expect(claims.filter(claim => claim.fresh)).toHaveLength(1);
    expect((await once.get(onceKey(step())))?.attempts).toBe(1);
  });

  it('never starts a done step again by itself', async () => {
    const { record } = await once.begin(step());
    await once.finish(record.key, 'the tool answered');
    const again = await once.begin(step());
    expect(again.fresh).toBe(false);
    expect(again.record.status).toBe('done');
    expect(again.record.result).toBe('the tool answered');
  });

  it('lets a step that certainly did not happen run again', async () => {
    const { record } = await once.begin(step());
    await once.fail(record.key, 'forbidden');
    const again = await once.begin(step());
    expect(again.fresh).toBe(true);
    expect(again.record.attempts).toBe(2);
  });

  it('settles only a step that is at "started": a late result never reopens or overwrites one', async () => {
    const { record } = await once.begin(step());
    await once.finish(record.key, 'sent');
    await once.fail(record.key, 'late failure');
    expect((await once.get(record.key))?.status).toBe('done');
    expect((await once.get(record.key))?.result).toBe('sent');
  });

  it('blocks a different step on the same site or tool while one there is cut off', async () => {
    await once.begin(step());
    // The same send in other words hashes differently, but the cut-off one still stands in the way
    const reworded = step({ target: 'hash-b' });
    expect((await once.blocking(reworded))?.target).toBe('hash-a');
    expect((await once.begin(reworded)).fresh).toBe(false);
    // Another tool, or another task, is not held up
    expect(await once.blocking(step({ target: 'hash-b', scope: 'slack:post_message' }))).toBeNull();
    expect(await once.blocking(step({ taskId: 'task-2' }))).toBeNull();
  });

  it('does not block further steps on a site once the earlier one is done', async () => {
    const { record } = await once.begin(step());
    await once.finish(record.key, 'sent');
    expect(await once.blocking(step({ target: 'hash-b' }))).toBeNull();
    expect((await once.begin(step({ target: 'hash-b' }))).fresh).toBe(true);
  });

  it('runs a step again only when the user chose to, and sets the cut-off ones aside', async () => {
    await once.begin(step());
    const again = await once.begin(step({ target: 'hash-b' }), { again: true });
    expect(again.fresh).toBe(true);
    expect((await once.get(onceKey(step())))?.status).toBe('superseded');
    // The same step the user re-runs keeps count, and a done one counts as redone
    await once.finish(again.record.key, 'sent');
    const third = await once.begin(step({ target: 'hash-b' }), { again: true });
    expect(third.record.attempts).toBe(2);
    expect(third.record.redone).toBe(1);
  });

  it('keeps a task’s records in order and drops old ones', async () => {
    const a = await once.begin(step({ target: 'a', scope: 's1' }));
    await once.finish(a.record.key, 'ok');
    await once.begin(step({ target: 'b', scope: 's2' }));
    expect((await once.forTask('task-1')).map(record => record.target)).toEqual(['a', 'b']);
    expect(await once.prune(Date.now() + 1)).toBe(2);
    expect(await once.forTask('task-1')).toEqual([]);
  });

  it('goes with its chat when the chat is deleted', async () => {
    const threads = createThreadStore(db);
    const thread = await threads.create();
    await once.begin(step({ threadId: thread.id }));
    await once.begin(step({ threadId: 'other', taskId: 'task-2' }));
    await threads.remove(thread.id);
    expect(await db.doOnce.count()).toBe(1);
  });
});

describe('database upgrade to version 7', () => {
  it('keeps every chat and adds the do-once table', async () => {
    const name = `upgrade7-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(6).stores({
      threads: 'id, updatedAt, status, agentId',
      messages: 'id, threadId, [threadId+seq]',
      jobs: 'id, kind, &key, runAt, status',
      ambientSessions: 'id, startedAt',
    });
    await old.table('threads').put({ id: 't1', updatedAt: 1, status: 'idle', title: 'Kept' });
    old.close();

    const upgraded = new AviCopilotDb(name);
    expect((await upgraded.threads.get('t1'))?.title).toBe('Kept');
    expect((await createOnceStore(upgraded).begin(step())).fresh).toBe(true);
    await upgraded.delete();
  });
});
