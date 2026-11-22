import { describe, expect, it } from 'vitest';
import type { Task, TaskChanges } from '@extension/storage';
import { makeTask, nov, at } from './helpers';
import { markAsked, snooze } from '../buttons';
import type { ButtonDeps } from '../buttons';
import { askedNext, snoozeNext } from '../rules';

function setup(task: Task | null, now: number) {
  const updates: { id: string; changes: TaskChanges }[] = [];
  let current = task;
  const deps: ButtonDeps = {
    tasks: {
      get: async () => current ?? undefined,
      update: async (id, changes) => {
        updates.push({ id, changes });
        if (!current) return null;
        current = { ...current, ...changes } as Task;
        return current;
      },
    },
    now: () => now,
  };
  return { deps, updates };
}

describe('markAsked', () => {
  it('sets askedAt, nextAt two working days on, count 1 and nextBy asked', async () => {
    const { deps } = setup(makeTask(), nov(26, 10));
    const saved = await markAsked('tsk_aaaaaaaaaa', deps);
    expect(saved.followUp).toEqual({ askedAt: nov(26, 10), nextAt: askedNext(nov(26, 10)), count: 1, nextBy: 'asked' });
    // Thu + 2 working days = Mon 30 Nov, at the start of the day
    expect(saved.followUp!.nextAt).toBe(new Date(2026, 10, 30).getTime());
  });

  it('counts how often he asked', async () => {
    const { deps } = setup(makeTask({ followUp: { count: 2, askedAt: 1, nextAt: 2, nextBy: 'snooze' } }), at(1, 9, 11));
    const saved = await markAsked('tsk_aaaaaaaaaa', deps);
    expect(saved.followUp).toMatchObject({ count: 3, nextBy: 'asked', askedAt: at(1, 9, 11) });
    expect(saved.followUp!.nextAt).toBe(new Date(2026, 11, 3).getTime());
  });

  it.each(['done', 'dropped'] as const)('refuses a %s task', async status => {
    const { deps, updates } = setup(makeTask({ status }), nov(26));
    await expect(markAsked('tsk_aaaaaaaaaa', deps)).rejects.toThrow('already closed');
    expect(updates).toEqual([]);
  });

  it('refuses a task that is gone', async () => {
    const { deps } = setup(null, nov(26));
    await expect(markAsked('tsk_zzzzzzzzzz', deps)).rejects.toThrow('no longer on the board');
  });
});

describe('snooze', () => {
  it.each([1, 3, 7])('%i days sets nextAt to the start of that day and nextBy snooze', async days => {
    const { deps } = setup(makeTask(), nov(23, 15));
    const saved = await snooze('tsk_aaaaaaaaaa', days, deps);
    expect(saved.followUp).toEqual({ count: 0, nextAt: snoozeNext(nov(23, 15), days), nextBy: 'snooze' });
  });

  it('keeps when he last asked and how often', async () => {
    const before = { askedAt: nov(20), nextAt: nov(24), count: 2, nextBy: 'asked' as const };
    const { deps } = setup(makeTask({ followUp: before }), nov(23, 15));
    const saved = await snooze('tsk_aaaaaaaaaa', 3, deps);
    expect(saved.followUp).toEqual({
      askedAt: nov(20),
      count: 2,
      nextAt: snoozeNext(nov(23, 15), 3),
      nextBy: 'snooze',
    });
  });

  it.each([0, 2, 5, 14, -1, 1.5])('refuses %s days', async days => {
    const { deps, updates } = setup(makeTask(), nov(23));
    await expect(snooze('tsk_aaaaaaaaaa', days, deps)).rejects.toThrow('1, 3 or 7');
    expect(updates).toEqual([]);
  });

  it('refuses a closed task', async () => {
    const { deps } = setup(makeTask({ status: 'done' }), nov(23));
    await expect(snooze('tsk_aaaaaaaaaa', 1, deps)).rejects.toThrow('already closed');
  });
});
