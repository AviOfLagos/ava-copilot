import { describe, expect, it } from 'vitest';
import { nov, makeTask, at } from './helpers';
import {
  addDays,
  addWorkingDays,
  askedNext,
  byMostOverdue,
  dueFollowUps,
  followUpDue,
  isWeekend,
  pickToday,
  snoozeNext,
  startOfDay,
  updateNext,
  workingDaysBetween,
} from '../rules';
import type { DueFollowUp } from '../rules';

// Calendar: Mon 23 Nov 2026, Thu 26, Fri 27, Sat 28, Sun 29, Mon 30, Tue 1 Dec, Wed 2 Dec.

describe('isWeekend', () => {
  it.each([
    ['2026-11-26', false],
    ['2026-11-27', false],
    ['2026-11-28', true],
    ['2026-11-29', true],
    ['2026-11-30', false],
  ])('%s -> %s', (day, expected) => {
    expect(isWeekend(day)).toBe(expected);
  });
});

describe('addDays', () => {
  it.each([
    ['2026-11-27', 1, '2026-11-28'],
    ['2026-11-30', 1, '2026-12-01'],
    ['2026-11-30', -1, '2026-11-29'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2026-11-23', 7, '2026-11-30'],
    ['2026-12-01', 0, '2026-12-01'],
  ])('%s + %i days = %s', (day, count, expected) => {
    expect(addDays(day, count)).toBe(expected);
  });
});

describe('addWorkingDays', () => {
  it.each([
    ['Fri -> Mon', '2026-11-27', 1, '2026-11-30'],
    ['Thu + 2 over a weekend', '2026-11-26', 2, '2026-11-30'],
    ['from a Saturday', '2026-11-28', 1, '2026-11-30'],
    ['from a Sunday', '2026-11-29', 1, '2026-11-30'],
    ['Sat + 3', '2026-11-28', 3, '2026-12-02'],
    ['Fri 27 Nov + 3 across a month end', '2026-11-27', 3, '2026-12-02'],
    ['Mon 30 Nov + 2', '2026-11-30', 2, '2026-12-02'],
    ['31 Dec 2026 + 2 across a year end', '2026-12-31', 2, '2027-01-04'],
    ['zero stays', '2026-11-27', 0, '2026-11-27'],
    ['negative counts as zero', '2026-11-27', -3, '2026-11-27'],
    ['Mon + 5 is the next Mon', '2026-11-23', 5, '2026-11-30'],
  ])('%s', (_name, day, count, expected) => {
    expect(addWorkingDays(day, count)).toBe(expected);
  });
});

describe('workingDaysBetween', () => {
  it.each([
    ['Fri -> Mon', '2026-11-27', '2026-11-30', 1],
    ['Thu -> Tue', '2026-11-26', '2026-12-01', 3],
    ['Sat -> Mon', '2026-11-28', '2026-11-30', 1],
    ['Sun -> Sun', '2026-11-29', '2026-11-29', 0],
    ['Fri -> Sat', '2026-11-27', '2026-11-28', 0],
    ['to is before from', '2026-11-30', '2026-11-27', 0],
    ['across a month end', '2026-11-27', '2026-12-02', 3],
    ['across a year end', '2026-12-31', '2027-01-04', 2],
    ['a whole week', '2026-11-23', '2026-11-30', 5],
  ])('%s', (_name, from, to, expected) => {
    expect(workingDaysBetween(from, to)).toBe(expected);
  });
});

describe('startOfDay', () => {
  it('is local midnight', () => {
    expect(startOfDay('2026-11-30')).toBe(new Date(2026, 10, 30, 0, 0, 0, 0).getTime());
  });
});

describe('followUpDue: undated task, three working days of quiet', () => {
  const heardThu = nov(26, 14);
  it.each([
    ['Fri 27', nov(27), false],
    ['Sat 28', nov(28), false],
    ['Sun 29', nov(29), false],
    ['Mon 30', nov(30), false],
    ['Tue 1 Dec', at(1, 9, 11), true],
    ['Wed 2 Dec', at(2, 9, 11), true],
  ])('heard Thu, asked on %s: due %s', (_day, now, due) => {
    const found = followUpDue({ status: 'open' }, heardThu, now);
    expect(!!found).toBe(due);
    if (due) expect(found!.reason).toBe('quiet');
  });

  it.each([
    ['heard Fri 27 -> due Wed 2 Dec', nov(27), at(1, 9, 11), false],
    ['heard Fri 27 -> due Wed 2 Dec', nov(27), at(2, 9, 11), true],
    ['heard Sat 28 -> not Tue 1 Dec', nov(28), at(1, 9, 11), false],
    ['heard Sat 28 -> due Wed 2 Dec', nov(28), at(2, 9, 11), true],
  ])('%s (now index)', (_name, heard, now, due) => {
    expect(!!followUpDue({ status: 'open' }, heard, now)).toBe(due);
  });

  it('nothing is due on a Saturday or Sunday, however long the silence', () => {
    for (const day of [28, 29]) expect(followUpDue({ status: 'open' }, nov(2), nov(day))).toBeNull();
  });

  it('since is the start of the working day it became due', () => {
    expect(followUpDue({ status: 'open' }, heardThu, at(2, 9, 11))!.since).toBe(startOfDay('2026-12-01'));
  });

  it('a done or dropped task is never due', () => {
    for (const status of ['done', 'dropped'] as const) {
      expect(followUpDue({ status, due: '2026-11-20' }, nov(2), nov(30))).toBeNull();
    }
  });
});

describe('followUpDue: a due date', () => {
  it.each([
    ['due Fri, on Fri', '2026-11-27', nov(27), null],
    ['due Fri, on Sat', '2026-11-27', nov(28), null],
    ['due Fri, on Sun', '2026-11-27', nov(29), null],
    ['due Fri, on Mon', '2026-11-27', nov(30), 'overdue'],
    ['due Sat, on Sat', '2026-11-28', nov(28), null],
    ['due Sat, on Sun (weekend exception)', '2026-11-28', nov(29), 'overdue'],
    ['due Sat, on Mon', '2026-11-28', nov(30), 'overdue'],
    ['due Sun, on Sun', '2026-11-29', nov(29), null],
    ['due Sun, on Mon', '2026-11-29', nov(30), 'overdue'],
    ['due in the future', '2026-12-02', nov(30), null],
    ['due Thu, on Fri', '2026-11-26', nov(27), 'overdue'],
  ])('%s', (_name, due, now, reason) => {
    const found = followUpDue({ status: 'open', due }, nov(1), now);
    expect(found?.reason ?? null).toBe(reason);
  });

  it('a dated task is chased by its date, not by quiet', () => {
    // Heard just now, but the date passed
    expect(followUpDue({ status: 'open', due: '2026-11-26' }, nov(27), nov(27))?.reason).toBe('overdue');
    // Heard long ago, but the date is not here yet
    expect(followUpDue({ status: 'open', due: '2026-12-10' }, nov(2), nov(27))).toBeNull();
  });
});

describe('followUpDue: Asked', () => {
  const askedState = (asked: number) => ({
    askedAt: asked,
    nextAt: askedNext(asked),
    count: 1,
    nextBy: 'asked' as const,
  });

  it.each([
    ['asked Thu: not due Fri', nov(26), nov(27), false],
    ['asked Thu: not due Sat', nov(26), nov(28), false],
    ['asked Thu: not due Sun', nov(26), nov(29), false],
    ['asked Thu: due Mon', nov(26), nov(30), true],
    ['asked Fri: not due Mon', nov(27), nov(30), false],
    ['asked Fri: due Tue', nov(27), at(1, 9, 11), true],
  ])('%s', (_name, asked, now, due) => {
    const found = followUpDue({ status: 'open', followUp: askedState(asked) }, nov(1), now);
    expect(!!found).toBe(due);
    if (due) expect(found!.reason).toBe('asked');
  });

  it('an overdue task that was asked is not due until nextAt', () => {
    const task = { status: 'open' as const, due: '2026-11-25', followUp: askedState(nov(26)) };
    expect(followUpDue(task, nov(1), nov(27))).toBeNull();
    expect(followUpDue(task, nov(1), nov(30))).toMatchObject({ reason: 'asked', since: startOfDay('2026-11-30') });
  });

  it('an asked task on a weekend shows nothing even after nextAt', () => {
    const task = { status: 'open' as const, followUp: { count: 1, nextAt: nov(27, 0), nextBy: 'asked' as const } };
    expect(followUpDue(task, nov(1), nov(28))).toBeNull();
  });
});

describe('snooze', () => {
  it.each([
    [1, '2026-11-24'],
    [3, '2026-11-26'],
    [7, '2026-11-30'],
  ])('snoozeNext from Mon 23 for %i days is the start of %s', (days, day) => {
    expect(snoozeNext(nov(23, 15), days)).toBe(startOfDay(day));
  });

  it.each([
    [1, nov(23, 22), false],
    [1, nov(24, 0), true],
    [3, nov(25, 17), false],
    [3, nov(26, 9), true],
    [7, nov(27, 9), false],
    [7, nov(30, 9), true],
  ])('snoozed %i days on Mon 23: at %s due=%s', (days, now, due) => {
    const task = {
      status: 'open' as const,
      followUp: { count: 0, nextAt: snoozeNext(nov(23, 11), days), nextBy: 'snooze' as const },
    };
    const found = followUpDue(task, nov(1), now);
    expect(!!found).toBe(due);
    if (due) expect(found!.reason).toBe('snoozed');
  });

  it('a snooze that ends on a Saturday shows on Monday', () => {
    // Wed 25 + 3 days = Sat 28
    const task = {
      status: 'open' as const,
      followUp: { count: 0, nextAt: snoozeNext(nov(25), 3), nextBy: 'snooze' as const },
    };
    expect(followUpDue(task, nov(1), nov(28))).toBeNull();
    expect(followUpDue(task, nov(1), nov(29))).toBeNull();
    expect(followUpDue(task, nov(1), nov(30))?.reason).toBe('snoozed');
  });
});

describe('askedNext and updateNext', () => {
  it.each([
    ['Mon 23', nov(23, 16), '2026-11-25'],
    ['Thu 26', nov(26), '2026-11-30'],
    ['Fri 27', nov(27), '2026-12-01'],
    ['Sat 28', nov(28), '2026-12-01'],
  ])('askedNext on %s is the start of %s', (_n, now, day) => {
    expect(askedNext(now)).toBe(startOfDay(day));
  });

  it.each([
    ['with by Thu 26', nov(23), '2026-11-26', '2026-11-27'],
    ['with by Fri 27', nov(23), '2026-11-27', '2026-11-30'],
    ['without by: three working days on', nov(23), undefined, '2026-11-26'],
    ['a by in the past is ignored', nov(27), '2026-11-20', '2026-12-02'],
    ['by today counts', nov(26), '2026-11-26', '2026-11-27'],
  ])('updateNext %s', (_n, said, by, day) => {
    expect(updateNext(said, by)).toBe(startOfDay(day));
  });

  it('an update restarts the clock: reason update after nextAt', () => {
    const task = {
      status: 'open' as const,
      followUp: { count: 0, nextAt: updateNext(nov(23), '2026-11-26'), nextBy: 'update' as const },
    };
    expect(followUpDue(task, nov(1), nov(26, 18))).toBeNull();
    expect(followUpDue(task, nov(1), nov(27))).toMatchObject({ reason: 'update' });
  });
});

describe('dueFollowUps ordering', () => {
  const now = nov(30);
  it('most overdue first (smallest since)', () => {
    const items = [
      { task: makeTask({ id: 'c', due: '2026-11-27' }), heardAt: 0 },
      { task: makeTask({ id: 'a', due: '2026-11-24' }), heardAt: 0 },
      { task: makeTask({ id: 'b', due: '2026-11-25' }), heardAt: 0 },
    ];
    expect(dueFollowUps(items, now).map(item => item.task.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves out what is not due', () => {
    const items = [
      { task: makeTask({ id: 'x', due: '2026-12-10' }), heardAt: 0 },
      { task: makeTask({ id: 'y', status: 'done', due: '2026-11-01' }), heardAt: 0 },
      { task: makeTask({ id: 'z', due: '2026-11-01' }), heardAt: 0 },
    ];
    expect(dueFollowUps(items, now).map(item => item.task.id)).toEqual(['z']);
  });

  it('ties on since go by due date, then createdAt', () => {
    const sameSince = (id: string, due: string | undefined, createdAt: number): DueFollowUp => ({
      task: makeTask({ id, ...(due ? { due } : {}), createdAt }),
      reason: 'asked',
      since: 100,
    });
    const sorted = [
      sameSince('undated', undefined, 1),
      sameSince('late-old', '2026-11-25', 1),
      sameSince('early-new', '2026-11-20', 9),
      sameSince('early-old', '2026-11-20', 2),
    ].sort(byMostOverdue);
    expect(sorted.map(item => item.task.id)).toEqual(['early-old', 'early-new', 'late-old', 'undated']);
  });
});

describe('pickToday', () => {
  const due = (count: number): DueFollowUp[] =>
    Array.from({ length: count }, (_, index) => ({
      task: makeTask({ id: `t${index + 1}` }),
      reason: 'overdue' as const,
      since: index + 1,
    }));
  const ids = (items: DueFollowUp[]) => items.map(item => item.task.id);

  it('eight due: five shown, the five most overdue', () => {
    const { shown, state } = pickToday(due(8), null, nov(30));
    expect(ids(shown)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(state).toEqual({ day: '2026-11-30', taskIds: ['t1', 't2', 't3', 't4', 't5'] });
  });

  it('answering one leaves four and no sixth takes its place the same day', () => {
    const first = pickToday(due(8), null, nov(30));
    const afterAnswer = due(8).filter(item => item.task.id !== 't2');
    const second = pickToday(afterAnswer, first.state, nov(30, 15));
    expect(ids(second.shown)).toEqual(['t1', 't3', 't4', 't5']);
    expect(second.state.taskIds).toEqual(first.state.taskIds);
  });

  it('the next day starts a new pick of five', () => {
    const first = pickToday(due(8), null, nov(30));
    const next = pickToday(due(8).slice(5), first.state, at(1, 9, 11));
    expect(ids(next.shown)).toEqual(['t6', 't7', 't8']);
    expect(next.state.day).toBe('2026-12-01');
    const fresh = pickToday(due(8), first.state, at(1, 9, 11));
    expect(ids(fresh.shown)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('fewer than five are all shown; a task that turns due later in the day joins while there is room', () => {
    const first = pickToday(due(2), null, nov(30));
    expect(ids(first.shown)).toEqual(['t1', 't2']);
    const later = pickToday(due(3), first.state, nov(30, 16));
    expect(ids(later.shown)).toEqual(['t1', 't2', 't3']);
  });

  it('respects a smaller max', () => {
    expect(ids(pickToday(due(4), null, nov(30), 2).shown)).toEqual(['t1', 't2']);
  });
});
