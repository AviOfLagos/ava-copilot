import { db, followUpDayStore, nameKey, peopleStore, taskStore } from '@extension/storage';
import type { FollowUpDayState, Person, PersonUpdate, Task } from '@extension/storage';
import { ownedByOther, ownerNames } from './owner';
import type { OwnerNames } from './owner';
import { dueFollowUps, pickToday } from './rules';
import type { DueFollowUp } from './rules';

/**
 * Today's follow-ups (docs/pm-desk.md, Part 9.2), gathered from the board, People and the person updates and
 * handed to the rules in ./rules.ts. What the brief, WhatsApp ("who's next") and the Inbox show. No model.
 */

export interface TodayDeps {
  openTasks: () => Promise<Task[]>;
  people: () => Promise<Person[]>;
  updates: () => Promise<Pick<PersonUpdate, 'personId' | 'name' | 'at' | 'workspaceId'>[]>;
  // When each meeting started, for the meetings a task was mentioned in
  meetingStarts: (ids: string[]) => Promise<Map<string, number>>;
  owner: () => Promise<OwnerNames>;
  day: { get(): Promise<FollowUpDayState>; set(state: FollowUpDayState): Promise<void> };
  now: () => number;
}

// Updates older than this say nothing about today's silence
const UPDATES_WINDOW = 120 * 24 * 60 * 60 * 1000;

export const defaultTodayDeps: TodayDeps = {
  openTasks: () => taskStore.list({ status: 'open' }),
  people: () => peopleStore.list(),
  updates: () =>
    db.personUpdates
      .where('at')
      .aboveOrEqual(Date.now() - UPDATES_WINDOW)
      .toArray(),
  meetingStarts: async ids => {
    const meetings = ids.length ? await db.meetings.bulkGet(ids) : [];
    return new Map(meetings.filter(meeting => !!meeting).map(meeting => [meeting!.id, meeting!.startedAt]));
  },
  owner: ownerNames,
  day: followUpDayStore,
  now: () => Date.now(),
};

/**
 * When anything was last heard about each task: when it was set, the latest meeting that mentioned it, and the
 * latest update from its owner (by person, or by the name as said while the task has no person yet).
 */
export function heardTimes(
  tasks: Task[],
  updates: Pick<PersonUpdate, 'personId' | 'name' | 'at' | 'workspaceId'>[],
  meetingStarts: ReadonlyMap<string, number>,
): Map<string, number> {
  const byPerson = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const update of updates) {
    if (update.personId) byPerson.set(update.personId, Math.max(byPerson.get(update.personId) ?? 0, update.at));
    else {
      const key = `${update.workspaceId ?? '*'}|${nameKey(update.name)}`;
      byName.set(key, Math.max(byName.get(key) ?? 0, update.at));
    }
  }
  const heard = new Map<string, number>();
  for (const task of tasks) {
    const mentioned = Math.max(0, ...task.seenIn.map(id => meetingStarts.get(id) ?? 0));
    const said = task.ownerId
      ? (byPerson.get(task.ownerId) ?? 0)
      : (byName.get(`${task.workspaceId ?? '*'}|${nameKey(task.ownerName)}`) ?? 0);
    heard.set(task.id, Math.max(task.createdAt, mentioned, said));
  }
  return heard;
}

/** Every follow-up due now, most overdue first: the tasks of people other than Avi only. */
export async function dueNow(deps: TodayDeps = defaultTodayDeps): Promise<DueFollowUp[]> {
  const [tasks, everyone, updates, owner] = await Promise.all([
    deps.openTasks(),
    deps.people(),
    deps.updates(),
    deps.owner(),
  ]);
  const peopleById = new Map(everyone.map(person => [person.id, person]));
  const theirs = tasks.filter(task => task.status === 'open' && ownedByOther(task, owner, peopleById));
  const starts = await deps.meetingStarts([...new Set(theirs.flatMap(task => task.seenIn))]);
  const heard = heardTimes(theirs, updates, starts);
  return dueFollowUps(
    theirs.map(task => ({ task, heardAt: heard.get(task.id) ?? task.createdAt })),
    deps.now(),
  );
}

// The brief, WhatsApp and the Inbox ask at once: one pick at a time, so the day's five are picked once
let running: Promise<unknown> = Promise.resolve();

/** Today's follow-ups: at most five a day, the first picked kept all day. */
export function followUpsToday(deps: TodayDeps = defaultTodayDeps): Promise<DueFollowUp[]> {
  const next = running.then(() => pickNow(deps));
  running = next.catch(() => undefined);
  return next;
}

async function pickNow(deps: TodayDeps): Promise<DueFollowUp[]> {
  const due = await dueNow(deps);
  const before = await deps.day.get();
  const { shown, state } = pickToday(due, before, deps.now());
  if (state.day !== before.day || state.taskIds.join() !== before.taskIds.join()) {
    await deps.day.set({ ...before, ...state });
  }
  return shown;
}
