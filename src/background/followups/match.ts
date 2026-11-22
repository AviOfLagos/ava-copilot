import { normaliseTitle, titleWords } from '@extension/storage';
import type { Task } from '@extension/storage';

/**
 * Which open task a "did" line is (docs/pm-desk.md, Part 9.1), in code: the task whose title's words are mostly in
 * what was said. Only a clear match counts; two tasks that fit as well as each other give none. A match is offered
 * as "Mark done?", never acted on: what a model read from a call is not proof.
 */

// Words a "did" line uses that say nothing about which task
const FILLER = new Set(['i', 'we', 'it', 'is', 'was', 'were', 'done', 'finished', 'did', 'have', 'has', 'just', 'got']);

const wordsOf = (text: string) => [...titleWords(text)].filter(word => !FILLER.has(word));

const shared = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};
/**
 * Two words fit when they are the same, or one is the other with a short ending changed: they share at least
 * three letters and all but the last letter of the shorter one ("send", "sent"; "deck", "decks"; "fix", "fixed";
 * "price", "pricing"). "deck" and "deploy" share only "de", so they do not.
 */
export const wordsFit = (a: string, b: string) => {
  if (a === b) return true;
  const common = shared(a, b);
  const shorter = Math.min(a.length, b.length);
  return common >= 3 && common >= shorter - 1 && Math.max(a.length, b.length) - common <= 3;
};
const fits = (word: string, said: readonly string[]) => said.some(other => wordsFit(word, other));

// A line that says it did not happen names a task without finishing it: "did not deploy", "not done: the deck"
const NEGATION =
  /\b(not|no|never|didn't|didnt|haven't|havent|hasn't|hasnt|isn't|isnt|wasn't|wasnt|yet to|still to|cannot|can't|cant|won't|wont)\b/i;
export const saysNotDone = (line: string) => NEGATION.test(line.replace(/[’‘]/g, "'"));

/** How much of a task's title a line holds: its title's words that are in the line, over all of them. */
// A title's opening verb says what kind of work it is, not which task: "Build the login page" is finished when
// someone says "finished the login page". It is left out of the count when the title has more words.
const ACTION_VERBS = new Set([
  'add',
  'book',
  'build',
  'call',
  'check',
  'create',
  'design',
  'do',
  'draft',
  'email',
  'finish',
  'fix',
  'get',
  'make',
  'order',
  'plan',
  'post',
  'prepare',
  'review',
  'send',
  'set',
  'share',
  'ship',
  'test',
  'update',
  'write',
]);

export function doneScore(line: string, title: string): { shared: number; of: number; exact: number } {
  const said = wordsOf(line);
  const all = wordsOf(title);
  const want = all.length > 1 && ACTION_VERBS.has(all[0]) ? all.slice(1) : all;
  return {
    shared: want.filter(word => fits(word, said)).length,
    of: want.length,
    exact: want.filter(word => said.includes(word)).length,
  };
}

// Enough of the title (three quarters to offer "Mark done?", most of it to say which task an update is about), at
// least two of its words, and a one-word title only by that very word
const clear = ({ shared: count, of, exact }: { shared: number; of: number; exact: number }, share = 0.75) =>
  of > 0 && count >= Math.min(2, of) && count / of >= share && (of > 1 || exact === 1);

/**
 * For each "did" line, the one open task it names, if exactly one fits best. Each task is offered once, for the
 * first line that names it.
 */
export function matchDone(
  did: string[],
  tasks: Pick<Task, 'id' | 'title' | 'status'>[],
): { taskId: string; said: string }[] {
  const open = tasks.filter(task => task.status === 'open');
  const offers: { taskId: string; said: string }[] = [];
  for (const line of did) {
    if (!normaliseTitle(line) || saysNotDone(line)) continue;
    const scored = open
      .map(task => ({ task, score: doneScore(line, task.title) }))
      .filter(item => clear(item.score))
      .sort((a, b) => b.score.shared / b.score.of - a.score.shared / a.score.of || b.score.shared - a.score.shared);
    if (!scored.length) continue;
    const [best, second] = scored;
    const tie =
      second &&
      second.score.shared / second.score.of === best.score.shared / best.score.of &&
      second.score.shared === best.score.shared;
    if (tie || offers.some(offer => offer.taskId === best.task.id)) continue;
    offers.push({ taskId: best.task.id, said: line.replace(/\s+/g, ' ').trim().slice(0, 300) });
  }
  return offers;
}

/** The open tasks a line of an update is about (for "ready Thursday" moving their next follow-up): every clear fit. */
export function tasksNamed(lines: string[], tasks: Pick<Task, 'id' | 'title' | 'status'>[]): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    for (const task of tasks) if (task.status === 'open' && clear(doneScore(line, task.title), 0.6)) ids.add(task.id);
  }
  return [...ids];
}

/**
 * Whether what the model says a person told the user is in the user's own words (rule 2): most of its words are
 * ones the user typed or said. A page or a call the model read cannot speak for him.
 */
export function wordsSaidByUser(said: string, userWords: string): boolean {
  const want = [...titleWords(said)].filter(word => word.length >= 3);
  if (want.length === 0) return false;
  const heard = [...titleWords(userWords)];
  const found = want.filter(word => heard.some(other => wordsFit(word, other))).length;
  return found / want.length >= 0.6;
}
