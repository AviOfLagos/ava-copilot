import { isoDay } from '@extension/storage';
import type { Task } from '@extension/storage';

/**
 * Who to chase, decided in code (docs/pm-desk.md, Part 9.2). Plain functions of the task, when anything about it was
 * last heard, and the clock, so every rule is tested on a fake one. Days are local calendar days ("YYYY-MM-DD").
 *
 * A task of someone other than Avi (../owner.ts decides that) is due a follow-up when:
 * - a next follow-up was set (he asked, snoozed it, or the person gave a new date) and that moment has come;
 *   until it comes nothing else makes it due;
 * - otherwise, its due date has passed;
 * - otherwise, it has no due date and nothing has been heard about it for three working days.
 * Weekends are not working days and show nothing, except a task whose due date fell on a weekend day, which is
 * chased from the day after it.
 */

// Working days of silence before an undated task is chased, and how far "Asked" puts the next follow-up
export const QUIET_WORKING_DAYS = 3;
export const ASKED_WORKING_DAYS = 2;
// The most follow-ups one day shows
export const DAILY_MAX = 5;
export const SNOOZE_DAYS = [1, 3, 7] as const;

const parse = (day: string) => {
  const [year, month, date] = day.split('-').map(Number);
  return { year, month: month - 1, date };
};

/** Noon of a day, local: day arithmetic at noon never trips over a clock change. */
const noonOf = (day: string) => {
  const { year, month, date } = parse(day);
  return new Date(year, month, date, 12).getTime();
};

/** The day `count` calendar days on (or back, when negative). */
export function addDays(day: string, count: number): string {
  const { year, month, date } = parse(day);
  return isoDay(new Date(year, month, date + count, 12).getTime());
}

/** Local midnight at the start of a day, in ms. */
export function startOfDay(day: string): number {
  const { year, month, date } = parse(day);
  return new Date(year, month, date, 0, 0, 0, 0).getTime();
}

/** Saturday or Sunday. */
export function isWeekend(day: string): boolean {
  const weekday = new Date(noonOf(day)).getDay();
  return weekday === 0 || weekday === 6;
}

/** The working day `count` working days after a day (the day itself never counts). */
export function addWorkingDays(day: string, count: number): string {
  let current = day;
  let left = Math.max(0, Math.floor(count));
  while (left > 0) {
    current = addDays(current, 1);
    if (!isWeekend(current)) left -= 1;
  }
  return current;
}

/** How many working days come after `from`, up to and including `to` (0 when `to` is not after `from`). */
export function workingDaysBetween(from: string, to: string): number {
  if (to <= from) return 0;
  let count = 0;
  // A year of days at most: silence longer than that is long enough
  for (let day = addDays(from, 1), n = 0; day <= to && n < 400; day = addDays(day, 1), n++) {
    if (!isWeekend(day)) count += 1;
  }
  return count;
}

/** Why a task is due a follow-up today. */
export type FollowUpReason =
  // Its due date passed
  | 'overdue'
  // No due date, and nothing heard for three working days
  | 'quiet'
  // He asked, and two working days went by
  | 'asked'
  // He snoozed it, and the snooze is over
  | 'snoozed'
  // The person gave a new date, and it came
  | 'update';

export interface DueFollowUp {
  task: Task;
  reason: FollowUpReason;
  // When it became due (ms): what "most overdue first" sorts by
  since: number;
}

/**
 * Whether one task is due a follow-up now, and why. `heardAt` is the last time anything was heard about it: when it
 * was set, a meeting that mentioned it, an update from its owner.
 */
export function followUpDue(
  task: Pick<Task, 'status' | 'due' | 'followUp'>,
  heardAt: number,
  now: number,
): { reason: FollowUpReason; since: number } | null {
  if (task.status !== 'open') return null;
  const today = isoDay(now);
  const weekend = isWeekend(today);
  // On a weekend, only a task that fell due this same weekend (a Saturday due date, chased on the Sunday)
  const dueThisWeekend = !!task.due && isWeekend(task.due) && task.due < today && task.due >= addDays(today, -1);
  const next = task.followUp?.nextAt;
  if (typeof next === 'number' && Number.isFinite(next)) {
    // Asked, snoozed, or a new date said: nothing else counts until that moment comes
    if (now < next) return null;
    if (weekend && !dueThisWeekend) return null;
    const by = task.followUp?.nextBy;
    return { reason: by === 'snooze' ? 'snoozed' : by === 'update' ? 'update' : 'asked', since: next };
  }
  if (task.due) {
    if (task.due >= today) return null;
    if (weekend && !dueThisWeekend) return null;
    return { reason: 'overdue', since: startOfDay(addDays(task.due, 1)) };
  }
  if (weekend) return null;
  const heard = isoDay(heardAt);
  if (workingDaysBetween(heard, today) < QUIET_WORKING_DAYS) return null;
  return { reason: 'quiet', since: startOfDay(addWorkingDays(heard, QUIET_WORKING_DAYS)) };
}

/** Most overdue first; then the earliest due date, then the oldest task. */
export function byMostOverdue(a: DueFollowUp, b: DueFollowUp): number {
  return (
    a.since - b.since ||
    (a.task.due ?? '9999').localeCompare(b.task.due ?? '9999') ||
    a.task.createdAt - b.task.createdAt ||
    a.task.id.localeCompare(b.task.id)
  );
}

/** Every due follow-up, most overdue first. */
export function dueFollowUps(items: { task: Task; heardAt: number }[], now: number): DueFollowUp[] {
  const due: DueFollowUp[] = [];
  for (const { task, heardAt } of items) {
    const found = followUpDue(task, heardAt, now);
    if (found) due.push({ task, ...found });
  }
  return due.sort(byMostOverdue);
}

/** The day's picks: which tasks today's follow-ups are, at most DAILY_MAX in a day. */
export interface FollowUpDay {
  day: string;
  taskIds: string[];
}

/**
 * Today's follow-ups out of the due ones (already most overdue first). The first five of the day are picked and
 * stay picked: one he answers (asked, done, snoozed) leaves the list without another taking its place, so a day
 * never shows more than five. A new day starts a new pick.
 */
export function pickToday(
  due: DueFollowUp[],
  state: FollowUpDay | null,
  now: number,
  max = DAILY_MAX,
): { shown: DueFollowUp[]; state: FollowUpDay } {
  const today = isoDay(now);
  const picked = state?.day === today ? [...state.taskIds] : [];
  for (const item of due) {
    if (picked.length >= max) break;
    if (!picked.includes(item.task.id)) picked.push(item.task.id);
  }
  const ids = new Set(picked);
  return { shown: due.filter(item => ids.has(item.task.id)), state: { day: today, taskIds: picked } };
}

/** Two working days after the day he asked, from the start of that day: "Asked". */
export function askedNext(now: number): number {
  return startOfDay(addWorkingDays(isoDay(now), ASKED_WORKING_DAYS));
}

/** One, three or seven calendar days on, from the start of that day: "Snooze". */
export function snoozeNext(now: number, days: number): number {
  return startOfDay(addDays(isoDay(now), days));
}

/**
 * When the person gave a new date (an update's "by"): chase on the first working day after it. Without one, the
 * clock restarts from the day of the update: three working days of quiet from then.
 */
export function updateNext(at: number, by?: string): number {
  if (by && by >= isoDay(at)) return startOfDay(addWorkingDays(by, 1));
  return startOfDay(addWorkingDays(isoDay(at), QUIET_WORKING_DAYS));
}
