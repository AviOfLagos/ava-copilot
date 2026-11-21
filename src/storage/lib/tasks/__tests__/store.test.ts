import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '../../threads/db';
import { byDueThenAge, createTaskStore } from '../store';
import type { TaskStore } from '../store';
import { isTaskId } from '../types';
import type { TaskCandidate } from '../types';

const DAY = 24 * 60 * 60 * 1000;
// Wednesday 18 November 2026, 10:00 local
const T0 = new Date(2026, 10, 18, 10).getTime();

let db: AviCopilotDb;
let clock: number;
let tasks: TaskStore;

const mention = (fields: Partial<TaskCandidate> = {}): TaskCandidate => ({
  title: 'Send the login to Ada',
  ownerName: 'Ada',
  workspaceId: 'ws-1',
  source: { kind: 'meeting', id: 'm-1' },
  at: T0,
  ...fields,
});

beforeEach(() => {
  db = new AviCopilotDb(`tasks-${crypto.randomUUID()}`);
  clock = T0;
  tasks = createTaskStore(db, { now: () => clock });
});

describe('recordTask', () => {
  it('makes an open task with an id, its source and its due date', async () => {
    const recorded = await tasks.record(mention({ dueText: 'by Friday' }));
    expect(recorded?.added).toBe(true);
    const task = recorded!.task;
    expect(isTaskId(task.id)).toBe(true);
    expect(task).toMatchObject({
      status: 'open',
      ownerName: 'Ada',
      ownerId: null,
      workspaceId: 'ws-1',
      workspaceSetBy: 'rule',
      due: '2026-11-20',
      dueText: 'by Friday',
      seenIn: ['m-1'],
      source: { kind: 'meeting', id: 'm-1' },
    });
  });

  it('makes the same task said in two meetings one task, seen in both', async () => {
    const first = await tasks.record(mention());
    const second = await tasks.record(
      mention({ title: 'Please send login to Ada.', source: { kind: 'meeting', id: 'm-2' }, at: T0 + 3 * DAY }),
    );
    expect(second?.added).toBe(false);
    expect(second?.task.id).toBe(first?.task.id);
    const all = await tasks.list();
    expect(all).toHaveLength(1);
    expect(all[0].seenIn).toEqual(['m-1', 'm-2']);
    expect(all[0].updatedAt).toBe(T0 + 3 * DAY);
  });

  it('changes nothing when the same source is recorded twice', async () => {
    await tasks.record(mention());
    const before = await tasks.list();
    await tasks.record(mention());
    expect(await tasks.list()).toEqual(before);
  });

  it('fills gaps from a later mention: the owner and the due date', async () => {
    await tasks.record(mention({ ownerName: 'Unassigned' }));
    const merged = await tasks.record(mention({ source: { kind: 'chat', id: 'c-1' }, dueText: 'tomorrow' }));
    expect(merged?.task).toMatchObject({ ownerName: 'Ada', due: '2026-11-19', dueText: 'tomorrow' });
  });

  it('keeps a due date already set', async () => {
    await tasks.record(mention({ dueText: 'by Friday' }));
    const merged = await tasks.record(mention({ source: { kind: 'meeting', id: 'm-2' }, dueText: 'Monday' }));
    expect(merged?.task.due).toBe('2026-11-20');
  });

  it('never reopens a task Avi closed, and does not add a second one', async () => {
    const first = await tasks.record(mention());
    clock = T0 + DAY;
    await tasks.setStatus(first!.task.id, 'done', 'avi');
    const again = await tasks.record(mention({ source: { kind: 'meeting', id: 'm-2' }, at: T0 + 2 * DAY }));
    expect(again?.added).toBe(false);
    expect(again?.task.status).toBe('done');
    expect(await tasks.list({ status: 'open' })).toHaveLength(0);
  });

  it('prefers the open task when a closed one has the same title', async () => {
    const closed = await tasks.add({ title: 'Send the login to Ada', workspaceId: 'ws-1', ownerName: 'Ada' });
    await tasks.setStatus(closed.id, 'dropped', 'avi');
    const open = await tasks.add({ title: 'Send the login to Ada', workspaceId: 'ws-1', ownerName: 'Ada' });
    const merged = await tasks.record(mention());
    expect(merged?.task.id).toBe(open.id);
  });

  it.each([
    ['another workspace', { workspaceId: 'ws-2' }],
    ['no workspace', { workspaceId: null }],
    ['another owner', { ownerName: 'Bo' }],
    ['more than 14 days later', { at: T0 + 15 * DAY }],
    ['another number', { title: 'Send the login to Ada 2' }],
    ['different work', { title: 'Send the invoice to Ada' }],
  ])('keeps apart a mention with %s', async (_why, fields) => {
    await tasks.record(mention());
    const second = await tasks.record(mention({ source: { kind: 'meeting', id: 'm-2' }, ...fields }));
    expect(second?.added).toBe(true);
    expect(await tasks.list()).toHaveLength(2);
  });

  it('is atomic: the same mention recorded at once makes one task', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => tasks.record(mention({ source: { kind: 'chat', id: `c-${i}` } }))),
    );
    const all = await tasks.list();
    expect(all).toHaveLength(1);
    expect(all[0].seenIn).toHaveLength(6);
  });

  it('ignores a mention with no words', async () => {
    expect(await tasks.record(mention({ title: '  ' }))).toBeNull();
  });
});

describe('the task store', () => {
  it('closes and reopens, with who and when', async () => {
    const task = await tasks.add({ title: 'Book the venue', workspaceId: null });
    clock = T0 + 60_000;
    const done = await tasks.setStatus(task.id, 'done', 'avi');
    expect(done).toMatchObject({ status: 'done', doneBy: 'avi', doneAt: T0 + 60_000, updatedAt: T0 + 60_000 });
    const reopened = await tasks.setStatus(task.id, 'open', 'avi');
    expect(reopened?.status).toBe('open');
    expect(reopened?.doneAt).toBeUndefined();
    expect(reopened?.doneBy).toBeUndefined();
  });

  it('lists by status, workspace (including none), owner and due date', async () => {
    const a = await tasks.add({ title: 'A', workspaceId: 'ws-1', due: '2026-11-20' });
    clock += 1;
    await tasks.add({ title: 'B', workspaceId: null });
    clock += 1;
    const c = await tasks.add({ title: 'C', workspaceId: 'ws-1', ownerId: 'p1' });
    await tasks.setStatus(c.id, 'done', 'avi');
    expect((await tasks.list({ workspaceId: 'ws-1' })).map(task => task.title)).toEqual(['A', 'C']);
    expect((await tasks.list({ workspaceId: null })).map(task => task.title)).toEqual(['B']);
    expect((await tasks.list({ status: 'open' })).map(task => task.title)).toEqual(['A', 'B']);
    expect((await tasks.list({ status: ['open', 'done'], ownerId: 'p1' })).map(task => task.id)).toEqual([c.id]);
    expect((await tasks.list({ dueBefore: '2026-11-21' })).map(task => task.id)).toEqual([a.id]);
  });

  it('sorts oldest due first, then oldest', async () => {
    const late = await tasks.add({ title: 'late', workspaceId: null, due: '2026-12-01' });
    clock += 1;
    const none = await tasks.add({ title: 'none', workspaceId: null });
    clock += 1;
    const soon = await tasks.add({ title: 'soon', workspaceId: null, due: '2026-11-19' });
    clock += 1;
    const none2 = await tasks.add({ title: 'none2', workspaceId: null });
    expect([none2, late, none, soon].sort(byDueThenAge).map(task => task.title)).toEqual([
      'soon',
      'late',
      'none',
      'none2',
    ]);
  });

  it('links an owner to a person for the people part', async () => {
    const task = await tasks.add({ title: 'Call Bo', workspaceId: null, ownerName: 'Bo' });
    const linked = await tasks.setOwner(task.id, 'person_1');
    expect(linked).toMatchObject({ ownerId: 'person_1', ownerName: 'Bo' });
  });

  it('merges two tasks: one is left, and the other id still finds it', async () => {
    const keep = await tasks.add({
      title: 'Write the brief',
      workspaceId: 'ws-1',
      source: { kind: 'meeting', id: 'm-1' },
    });
    const drop = await tasks.add({
      title: 'Brief: write it',
      workspaceId: 'ws-1',
      ownerName: 'Ada',
      due: '2026-11-25',
      source: { kind: 'chat', id: 'c-1' },
      links: [{ label: 'Doc', url: 'https://example.com/doc' }],
    });
    const merged = await tasks.merge(keep.id, drop.id);
    expect(merged).toMatchObject({
      id: keep.id,
      ownerName: 'Ada',
      due: '2026-11-25',
      seenIn: ['m-1', 'c-1'],
      mergedIds: [drop.id],
      links: [{ label: 'Doc', url: 'https://example.com/doc' }],
    });
    expect(await tasks.list()).toHaveLength(1);
    expect((await tasks.get(drop.id))?.id).toBe(keep.id);
    // A tick through the old id closes the kept task
    await tasks.setStatus(drop.id, 'done', 'avi');
    expect((await tasks.get(keep.id))?.status).toBe('done');
  });

  it('moves tasks, but a rule or Ava never moves one whose workspace Avi chose', async () => {
    const mine = await tasks.add({ title: 'Mine', workspaceId: 'ws-1' });
    const ruled = (await tasks.record(mention({ title: 'Ruled' })))!.task;
    const byRule = await tasks.move([mine.id, ruled.id], 'ws-2', 'rule');
    expect(byRule.map(task => task.id)).toEqual([ruled.id]);
    expect((await tasks.get(mine.id))?.workspaceId).toBe('ws-1');
    const byAvi = await tasks.move([mine.id, ruled.id], null, 'avi');
    expect(byAvi).toHaveLength(2);
    expect(await tasks.get(ruled.id)).toMatchObject({ workspaceId: null, workspaceSetBy: 'avi' });
    expect(await tasks.move([ruled.id], 'ws-3', 'ava')).toHaveLength(0);
  });

  it('updates words but not the id, workspace or status', async () => {
    const task = await tasks.add({ title: 'Old', workspaceId: 'ws-1' });
    const next = await tasks.update(task.id, { title: '  New   words ', ownerName: 'Unassigned' });
    expect(next).toMatchObject({
      id: task.id,
      title: 'New words',
      ownerName: null,
      workspaceId: 'ws-1',
      status: 'open',
    });
  });

  it('drops open tasks nobody touched for two weeks, and only those', async () => {
    const old = await tasks.add({ title: 'Old', workspaceId: null });
    const doneOld = await tasks.add({ title: 'Done old', workspaceId: null });
    await tasks.setStatus(doneOld.id, 'done', 'avi');
    clock = T0 + 10 * DAY;
    const fresh = await tasks.add({ title: 'Fresh', workspaceId: null });
    clock = T0 + 15 * DAY;
    expect(await tasks.closeOlderThan()).toBe(1);
    expect((await tasks.get(old.id))?.status).toBe('dropped');
    expect((await tasks.get(doneOld.id))?.status).toBe('done');
    expect((await tasks.get(fresh.id))?.status).toBe('open');
  });

  it('tells a listener about changes', async () => {
    const seen: number[] = [];
    const stop = tasks.onChange(all => seen.push(all.length));
    await new Promise(resolve => setTimeout(resolve, 20));
    await tasks.add({ title: 'One', workspaceId: null });
    // Live queries report on their own clock: wait for it rather than for a fixed time
    for (let i = 0; i < 100 && seen.at(-1) !== 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
    stop();
    expect(seen.at(-1)).toBe(1);
  });
});
