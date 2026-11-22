import { describe, expect, it } from 'vitest';
import type { FollowUpDayState, Person, PersonUpdate, Task } from '@extension/storage';
import { makeTask, nov, at } from './helpers';
import { dueNow, followUpsToday, heardTimes } from '../today';
import type { TodayDeps } from '../today';
import { ownerNamesOf } from '../owner';

type UpdateRow = Pick<PersonUpdate, 'personId' | 'name' | 'at' | 'workspaceId'>;

const person = (id: string, name: string, aliases: string[] = []) =>
  ({ id, name, aliases: aliases.map(text => ({ text })), workspaceIds: [] }) as unknown as Person;

function deps(
  tasks: Task[],
  options: {
    now: number;
    people?: Person[];
    updates?: UpdateRow[];
    starts?: Record<string, number>;
    day?: FollowUpDayState;
  },
) {
  let day: FollowUpDayState = options.day ?? { day: '', taskIds: [] };
  const sets: FollowUpDayState[] = [];
  const value: TodayDeps = {
    openTasks: async () => tasks,
    people: async () => options.people ?? [],
    updates: async () => options.updates ?? [],
    meetingStarts: async ids => new Map(ids.filter(id => options.starts?.[id]).map(id => [id, options.starts![id]])),
    owner: async () => ownerNamesOf('Avi Example'),
    day: {
      get: async () => day,
      set: async state => {
        day = state;
        sets.push(state);
      },
    },
    now: () => options.now,
  };
  return { value, sets, day: () => day };
}

// Created Mon 16 Nov: by Mon 23 Nov it has been quiet for five working days
const OLD = nov(16);
const NOW = nov(23, 10);

describe("dueNow: only other people's tasks", () => {
  const owned = (id: string, ownerName: string | null, extra: Partial<Task> = {}) =>
    makeTask({ id, ownerName, createdAt: OLD, ...extra });

  it.each([['me'], ['I'], ['You'], ['Avi Example'], ['Avi'], ['Unassigned'], ['team'], [null]])(
    'a task of %s is never a follow-up',
    async name => {
      const { value } = deps([owned('t1', name)], { now: NOW });
      expect(await dueNow(value)).toEqual([]);
    },
  );

  it('a task linked to a person who is Avi (by name or alias) is never one', async () => {
    const tasks = [owned('t1', 'Someone', { ownerId: 'p1' }), owned('t2', 'Someone', { ownerId: 'p2' })];
    const people = [person('p1', 'Avi Example'), person('p2', 'Other Name', ['Avi'])];
    const { value } = deps(tasks, { now: NOW, people });
    expect(await dueNow(value)).toEqual([]);
  });

  it("Ada's quiet task is one", async () => {
    const { value } = deps([owned('t1', 'Ada'), owned('t2', 'Avi')], { now: NOW });
    const due = await dueNow(value);
    expect(due.map(item => item.task.id)).toEqual(['t1']);
    expect(due[0].reason).toBe('quiet');
  });

  it('a recently made task is not due yet', async () => {
    const { value } = deps([owned('t1', 'Ada', { createdAt: nov(20) })], { now: NOW });
    expect(await dueNow(value)).toEqual([]);
  });
});

describe('heardTimes', () => {
  const t = (fields: Partial<Task>) => makeTask({ createdAt: nov(10), ...fields });

  it('is the creation time when nothing else was heard', () => {
    expect(heardTimes([t({ id: 'a' })], [], new Map()).get('a')).toBe(nov(10));
  });

  it('takes the latest meeting that mentioned it', () => {
    const task = t({ id: 'a', seenIn: ['m1', 'm2', 'gone'] });
    const starts = new Map([
      ['m1', nov(12)],
      ['m2', nov(18)],
    ]);
    expect(heardTimes([task], [], starts).get('a')).toBe(nov(18));
  });

  it('a meeting older than the task does not move it back', () => {
    const task = t({ id: 'a', seenIn: ['m1'] });
    expect(heardTimes([task], [], new Map([['m1', nov(2)]])).get('a')).toBe(nov(10));
  });

  it('an update from the owner by personId restarts the clock', () => {
    const task = t({ id: 'a', ownerId: 'p1', ownerName: 'Ada' });
    const updates: UpdateRow[] = [
      { personId: 'p1', name: 'Ada', at: nov(19), workspaceId: null },
      { personId: 'p1', name: 'Ada', at: nov(17), workspaceId: null },
      { personId: 'p2', name: 'Ben', at: nov(22), workspaceId: null },
    ];
    expect(heardTimes([task], updates, new Map()).get('a')).toBe(nov(19));
  });

  it('by name, in the same workspace, while the task has no ownerId', () => {
    const task = t({ id: 'a', ownerName: 'Ada', workspaceId: 'w1' });
    const updates: UpdateRow[] = [
      { personId: null, name: 'ada', at: nov(20), workspaceId: 'w1' },
      { personId: null, name: 'Ada', at: nov(22), workspaceId: 'w2' },
    ];
    expect(heardTimes([task], updates, new Map()).get('a')).toBe(nov(20));
  });

  it('a task with an ownerId ignores updates said only by name', () => {
    const task = t({ id: 'a', ownerId: 'p1', ownerName: 'Ada' });
    const updates: UpdateRow[] = [{ personId: null, name: 'Ada', at: nov(22), workspaceId: null }];
    expect(heardTimes([task], updates, new Map()).get('a')).toBe(nov(10));
  });

  it('the latest of all three wins', () => {
    const task = t({ id: 'a', ownerId: 'p1', seenIn: ['m1'] });
    const updates: UpdateRow[] = [{ personId: 'p1', name: 'Ada', at: nov(16), workspaceId: null }];
    expect(heardTimes([task], updates, new Map([['m1', nov(17)]])).get('a')).toBe(nov(17));
  });
});

describe('an update from the person restarts the quiet clock', () => {
  it('quiet task becomes not due after an update, and due again three working days later', async () => {
    const task = makeTask({ id: 't1', ownerId: 'p1', ownerName: 'Ada', createdAt: OLD });
    const update: UpdateRow = { personId: 'p1', name: 'Ada', at: nov(23, 8), workspaceId: null };
    const quiet = deps([task], { now: NOW });
    expect(await dueNow(quiet.value)).toHaveLength(1);
    const heard = deps([task], { now: NOW, updates: [update] });
    expect(await dueNow(heard.value)).toEqual([]);
    // Thu 26 is three working days after Mon 23; Wed is not yet
    expect(await dueNow(deps([task], { now: nov(25), updates: [update] }).value)).toEqual([]);
    expect(await dueNow(deps([task], { now: nov(26), updates: [update] }).value)).toHaveLength(1);
  });

  it('a meeting mention restarts it too', async () => {
    const task = makeTask({ id: 't1', createdAt: OLD, seenIn: ['m9'] });
    const { value } = deps([task], { now: NOW, starts: { m9: nov(23, 9) } });
    expect(await dueNow(value)).toEqual([]);
  });
});

describe('followUpsToday', () => {
  const eight = Array.from({ length: 8 }, (_, index) =>
    makeTask({
      id: `t${index + 1}`,
      ownerName: 'Ada',
      due: `2026-11-${String(10 + index).padStart(2, '0')}`,
      createdAt: OLD,
    }),
  );

  it("shows five and stores the day's picks", async () => {
    const d = deps(eight, { now: NOW });
    const shown = await followUpsToday(d.value);
    expect(shown.map(item => item.task.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(d.day()).toMatchObject({ day: '2026-11-23', taskIds: ['t1', 't2', 't3', 't4', 't5'] });
  });

  it('after one is answered, four are left and no sixth is added', async () => {
    const d = deps(eight, { now: NOW });
    await followUpsToday(d.value);
    const remaining = eight.filter(task => task.id !== 't3');
    const again = deps(remaining, { now: nov(23, 15), day: d.day() });
    const shown = await followUpsToday(again.value);
    expect(shown.map(item => item.task.id)).toEqual(['t1', 't2', 't4', 't5']);
  });

  it('the next day starts a new pick', async () => {
    const d = deps(eight, { now: NOW });
    await followUpsToday(d.value);
    const next = deps(eight.slice(5), { now: at(24), day: d.day() });
    const shown = await followUpsToday(next.value);
    expect(shown.map(item => item.task.id)).toEqual(['t6', 't7', 't8']);
    expect(next.day().day).toBe('2026-11-24');
  });

  it('keeps the inbox day when the pick is saved', async () => {
    const d = deps(eight, { now: NOW, day: { day: '2026-11-22', taskIds: ['x'], inboxDay: '2026-11-22' } });
    await followUpsToday(d.value);
    expect(d.day().inboxDay).toBe('2026-11-22');
  });
});
