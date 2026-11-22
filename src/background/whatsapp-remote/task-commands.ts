/**
 * What Avi types on WhatsApp about his tasks (docs/pm-desk.md, Part 8), read here rather than by a model, like the
 * commands in ./commands.ts: "done 2", "2 done", "done 2 4 5", "undo 2", "reopen 2", "drop 2", "tasks",
 * "tasks ada", "tasks for ada", "tasks in ember", "task for ada: send the deck by friday", "who's next". Only a
 * message that is nothing but the command counts, so anything longer still goes to the chat.
 */

export type TaskStatusWord = 'done' | 'open' | 'dropped';

export type TaskCommand =
  // Tasks by their numbers in a list Ava sent: the one he quoted, else the latest
  | { kind: 'set'; status: TaskStatusWord; numbers: number[] }
  // Open tasks: all of them, or for a word that may be a person or a workspace (`as` when he said which)
  | { kind: 'list'; word: string | null; as: 'person' | 'workspace' | null }
  // A new task for someone, the owner as he wrote it
  | { kind: 'add'; owner: string; words: string }
  // Today's follow-ups
  | { kind: 'next' };

// The most numbers one message names, and the largest number a list can have
const NUMBERS_MAX = 15;
const NUMBER_MAX = 999;

const VERBS: Record<string, TaskStatusWord> = {
  done: 'done',
  did: 'done',
  finished: 'done',
  closed: 'done',
  close: 'done',
  complete: 'done',
  completed: 'done',
  undo: 'open',
  reopen: 'open',
  're-open': 'open',
  drop: 'dropped',
  dropped: 'dropped',
};
const VERB = Object.keys(VERBS).join('|');
// "2", "#2", "2 4 5", "2, 4 and 5", "2 & 4"
const NUMBER = '#?\\d{1,3}';
const NUMBERS = `${NUMBER}(?:\\s*(?:,|&|and|\\s)\\s*${NUMBER})*`;
const POLITE = '(?:(?:ava|hey ava|ok|okay)[,\\s]+)?';
const END = '[\\s.!]*';

const SET_FIRST = new RegExp(`^${POLITE}(${VERB})\\s*[:-]?\\s*(${NUMBERS})${END}$`, 'iu');
const SET_LAST = new RegExp(`^${POLITE}(${NUMBERS})\\s+(?:is\\s+|are\\s+)?(${VERB})${END}$`, 'iu');
const LIST = new RegExp(`^${POLITE}(?:my\\s+|open\\s+)?(?:tasks|task list|todos)${END}$`, 'iu');
const LIST_FOR = new RegExp(`^${POLITE}(?:open\\s+)?tasks\\s+(for|of|in)\\s+([^:\\n]{1,60}?)\\s*[?.!]*$`, 'iu');
const LIST_WORD = new RegExp(`^${POLITE}(?:open\\s+)?tasks\\s+([^:\\n]{1,60}?)\\s*[?.!]*$`, 'iu');
// "task for ada: …" or "task for ada - …"; a hyphen inside a name ("Mary-Jane") is no separator
const ADD = new RegExp(
  `^${POLITE}(?:new\\s+|add\\s+(?:a\\s+)?)?task\\s+for\\s+([^:\\n]{1,60}?)(?:\\s*:|\\s+[-–—])\\s*([\\s\\S]+)$`,
  'iu',
);
const NEXT = new RegExp(`^${POLITE}(?:who[’']?s|who is)\\s+next\\s*[?.!]*$`, 'iu');

/** The numbers in "2, 4 and 5": each once, in the order said; null when one is out of bounds. */
function numbersOf(text: string): number[] | null {
  const numbers = [...new Set((text.match(/\d{1,3}/g) ?? []).map(Number))];
  if (!numbers.length || numbers.length > NUMBERS_MAX) return null;
  return numbers.every(number => number >= 1 && number <= NUMBER_MAX) ? numbers : null;
}

/** The task command a whole message is, or null when it is anything else. */
export function taskCommandOf(text: string): TaskCommand | null {
  const words = text.trim().replace(/\s+/g, ' ');
  if (!words || words.length > 600) return null;
  const first = SET_FIRST.exec(words);
  const last = first ? null : SET_LAST.exec(words);
  if (first || last) {
    const verb = (first ? first[1] : last![2]).toLowerCase();
    const numbers = numbersOf(first ? first[2] : last![1]);
    return numbers ? { kind: 'set', status: VERBS[verb], numbers } : null;
  }
  if (NEXT.test(words)) return { kind: 'next' };
  if (LIST.test(words)) return { kind: 'list', word: null, as: null };
  // Before the lists: "task for ada: …" is a new task, "tasks for ada" a list
  const add = ADD.exec(words);
  if (add) {
    const owner = add[1].trim();
    const task = add[2].trim();
    return owner && task ? { kind: 'add', owner, words: task } : null;
  }
  const scoped = LIST_FOR.exec(words);
  if (scoped) {
    const word = scoped[2].trim();
    return word ? { kind: 'list', word, as: scoped[1].toLowerCase() === 'in' ? 'workspace' : 'person' } : null;
  }
  const list = LIST_WORD.exec(words);
  if (list) {
    const word = list[1].trim();
    return word ? { kind: 'list', word, as: null } : null;
  }
  return null;
}
