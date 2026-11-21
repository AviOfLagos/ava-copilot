import type { Task, TaskCandidate } from './types';

// The merge rules of docs/pm-desk.md, Part 2.2, as code. No model is involved.

const DAY = 24 * 60 * 60 * 1000;
// A new mention joins a task only within this long of the task's last change
export const MERGE_WINDOW = 14 * DAY;
// The least word overlap at which two titles are the same task
export const MIN_OVERLAP = 0.85;
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'for',
  'and',
  'on',
  'in',
  'with',
  'please',
]);

// What a meeting note writes when nobody was named, and the like: no owner
const NO_OWNER = new Set(['', 'unassigned', 'nobody', 'none', 'no one', 'noone', 'tbd', 'n a', 'na', 'unknown']);

/** Lower case, punctuation and extra spaces removed. An apostrophe joins its word ("don't" is "dont"). */
export function normaliseTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The title's words without the stop list. */
export function titleWords(title: string): Set<string> {
  return new Set(
    normaliseTitle(title)
      .split(' ')
      .filter(word => word && !STOP_WORDS.has(word)),
  );
}

/** Jaccard overlap of two word sets: shared words over all words. Two empty sets do not overlap. */
export function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Every number in a title ("PR 12", "v1.2", "3pm" give 12, 1.2, 3). */
export function numbersOf(title: string): Set<string> {
  return new Set((title.match(/\d+(?:[.,]\d+)*/g) ?? []).map(number => number.replace(/,/g, '.')));
}

/** Whether two titles name the same thing to do. */
export function sameTitle(a: string, b: string): boolean {
  const numbersA = numbersOf(a);
  const numbersB = numbersOf(b);
  // Every number in one title is in the other: "PR 12" and "PR 13" stay apart
  for (const number of numbersA) if (!numbersB.has(number)) return false;
  for (const number of numbersB) if (!numbersA.has(number)) return false;
  const plainA = normaliseTitle(a);
  if (plainA && plainA === normaliseTitle(b)) return true;
  return overlap(titleWords(a), titleWords(b)) >= MIN_OVERLAP;
}

/** An owner's name as compared, or null when the words name nobody. */
export function ownerKey(name: string | null | undefined): string | null {
  const key = normaliseTitle(name ?? '');
  return NO_OWNER.has(key) ? null : key;
}

/** The same owner, or one side without an owner. A person id, when both have one, decides. */
export function sameOwner(
  task: Pick<Task, 'ownerId' | 'ownerName'>,
  candidate: Pick<TaskCandidate, 'ownerId' | 'ownerName'>,
): boolean {
  if (task.ownerId && candidate.ownerId) return task.ownerId === candidate.ownerId;
  const a = ownerKey(task.ownerName);
  const b = ownerKey(candidate.ownerName);
  return a === null || b === null || a === b;
}

/**
 * Whether a mention is a task already on the board. All of these hold: the same workspace; the same owner or one
 * side without one; the mention is within 14 days of the task's last change; and the titles match.
 */
export function isSameTask(task: Task, candidate: TaskCandidate, at: number): boolean {
  return (
    (task.workspaceId ?? null) === (candidate.workspaceId ?? null) &&
    sameOwner(task, candidate) &&
    Math.abs(at - task.updatedAt) <= MERGE_WINDOW &&
    sameTitle(task.title, candidate.title)
  );
}

/**
 * The task a mention joins, if any: an open one first, then the latest. A closed one still takes the mention, so
 * a task said again after it was ticked does not come back as a second one, and it stays closed.
 */
export function findSameTask(tasks: Task[], candidate: TaskCandidate, at: number): Task | undefined {
  return tasks
    .filter(task => isSameTask(task, candidate, at))
    .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.updatedAt - a.updatedAt)[0];
}
