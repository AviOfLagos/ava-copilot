/**
 * Hearing "Ava, note a task for Ada: …" in words already written down (docs/pm-desk.md, Part 6). Plain code, no
 * model (rule 6). Whose words these are is decided before they get here (see ./engine.ts): this file only reads them.
 *
 *   (hey)? ava[,]? (please)? (note|add|log|create) (a)? task for <name>[:,]? <words>
 *
 * "Ava" also matches what recognisers write for it (`callWords` in src/offscreen/stt/addressed.ts).
 */
import { callWords } from '../../offscreen/stt/addressed';

const VERBS = new Set(['note', 'add', 'log', 'create']);
// "note down a task", "add a new task": small words a person says in between, never the name
const FILLERS = new Set(['down', 'up', 'new', 'quick']);
const ARTICLES = new Set(['a', 'an', 'the', 'one', 'another']);
// A name is at most this many words, and only with a ":" or "," after it; with neither it is one word
const MAX_NAME_WORDS = 3;
// What makes "for me" a task for Avi himself, not for a person called "me"
const SELF_WORDS = new Set(['me', 'myself']);

// What a sentence can start with to add to the task still open
const ADDITIONS = [/^also\b/i, /^and\b/i, /^add to that\b/i, /^plus\b/i];

interface Token {
  text: string;
  // lower case, quotes straightened, a trailing "'s" kept
  word: string;
  start: number;
  end: number;
  // ':' ',' ';' '.' '!' '?' or '' for a word
  mark: string;
}

function tokens(text: string): Token[] {
  const found: Token[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*|[,:;.!?]/gu)) {
    const raw = match[0];
    const isMark = /^[,:;.!?]$/.test(raw);
    found.push({
      text: raw,
      word: isMark ? '' : raw.toLowerCase().replace(/’/g, "'"),
      start: match.index ?? 0,
      end: (match.index ?? 0) + raw.length,
      mark: isMark ? raw : '',
    });
  }
  return found;
}

export interface Command {
  // The name as said (vocabulary correction comes later); null for "a task for me"
  name: string | null;
  // What is to be done, as said, without the command words; may be empty when the words come next
  words: string;
  // Where in the text the command starts (its "hey" or "Ava") and where its words start
  start: number;
  wordsStart: number;
}

/**
 * The command starts in `text`, in order. Each command's words run to the next command or the end of the text, so
 * "… Ava, note a task for Ben: …" in one breath is two tasks, never one.
 */
export function findCommands(text: string, assistantName = 'Ava'): Command[] {
  const names = callWords(assistantName);
  const list = tokens(text);
  const heads: { start: number; nameAt: number; nameEnd: number; wordsAt: number; name: string | null }[] = [];

  for (let i = 0; i < list.length; i++) {
    if (!names.includes(list[i].word)) continue;
    let j = i + 1;
    const skipMarks = () => {
      while (j < list.length && (list[j].mark === ',' || list[j].mark === ':')) j++;
    };
    skipMarks();
    // "Ava, can you please note…"
    if (['can', 'could', 'would', 'will'].includes(list[j]?.word ?? '') && list[j + 1]?.word === 'you') j += 2;
    if (list[j]?.word === 'please') {
      j++;
      skipMarks();
    }
    if (!VERBS.has(list[j]?.word ?? '')) continue;
    j++;
    while (FILLERS.has(list[j]?.word ?? '')) j++;
    if (ARTICLES.has(list[j]?.word ?? '')) j++;
    while (FILLERS.has(list[j]?.word ?? '')) j++;
    if (list[j]?.word !== 'task') continue;
    j++;
    if (list[j]?.word !== 'for') continue;
    j++;
    // The name: up to three words before a ":" or ",", each capitalised as names are written; else one word
    const nameAt = j;
    let nameEnd = -1;
    for (let k = j; k < list.length && k < j + MAX_NAME_WORDS + 1; k++) {
      if (list[k].mark === ':' || list[k].mark === ',') {
        if (k > j) nameEnd = k;
        break;
      }
      if (list[k].mark || (k > j && !/^\p{Lu}/u.test(list[k].text))) break;
    }
    if (nameEnd === -1) nameEnd = list[j] && !list[j].mark ? j + 1 : j;
    if (nameEnd <= nameAt) continue;
    const nameTokens = list.slice(nameAt, nameEnd).filter(token => !token.mark);
    if (!nameTokens.length) continue;
    const spoken = text.slice(nameTokens[0].start, nameTokens[nameTokens.length - 1].end).trim();
    let wordsAt = nameEnd;
    while (wordsAt < list.length && (list[wordsAt].mark === ':' || list[wordsAt].mark === ',')) wordsAt++;
    // "a task for Ada to send the deck": the "to" is the command's, not the task's
    if (list[wordsAt]?.word === 'to') wordsAt++;
    // "hey Ava": the command starts at the "hey"
    const start = i > 0 && list[i - 1].word === 'hey' ? list[i - 1].start : list[i].start;
    heads.push({
      start,
      nameAt,
      nameEnd,
      wordsAt,
      name: nameTokens.length === 1 && SELF_WORDS.has(nameTokens[0].word) ? null : spoken,
    });
    i = wordsAt - 1;
  }

  return heads.map((head, index) => {
    const wordsStart = list[head.wordsAt]?.start ?? text.length;
    const end = index + 1 < heads.length ? heads[index + 1].start : text.length;
    return {
      name: head.name,
      words: cleanWords(text.slice(Math.min(wordsStart, end), end)),
      start: head.start,
      wordsStart,
    };
  });
}

/** The words of a task as one line: no leading marks, no trailing full stop, no stray spaces. */
export function cleanWords(words: string): string {
  return words
    .replace(/\s+/g, ' ')
    .replace(/^[\s,:;.!?-]+/, '')
    .replace(/[\s,;:.]+$/, '')
    .trim();
}

/**
 * The sentences of a stretch of speech. Captions and recognisers put in ". ? ! ;"; where they do not, a command
 * still starts its own sentence (findCommands splits there).
 */
export function sentencesOf(text: string): { text: string; ended: boolean }[] {
  const parts: { text: string; ended: boolean }[] = [];
  const pattern = /[^.!?;]+(?:[.!?;]+|$)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (!trimmed || /^[.!?;]+$/.test(trimmed)) continue;
    parts.push({ text: trimmed, ended: /[.!?;]$/.test(trimmed) });
  }
  return parts;
}

/**
 * Whether a sentence adds to the task still open ("also…", "and…", "add to that…", "Ava, …"), and if so the words
 * it adds. A sentence that is a new command is not an addition (findCommands comes first).
 */
export function additionOf(sentence: string, assistantName = 'Ava'): string | null {
  const trimmed = sentence.trim();
  for (const pattern of ADDITIONS) {
    if (pattern.test(trimmed)) return cleanWords(trimmed.replace(pattern, '')) || null;
  }
  // "Ava, make it by Friday": her name and a comma, then the words
  const names = callWords(assistantName);
  const named = trimmed.match(/^([\p{L}'’]+)\s*,\s*(.+)$/u);
  if (named && names.includes(named[1].toLowerCase())) return cleanWords(named[2]) || null;
  return null;
}

/** Lower-case words only, for comparing two readings of the same speech. */
export function wordsKey(text: string): string[] {
  return tokens(text)
    .filter(token => !token.mark)
    .map(token => token.word);
}

/** How alike two readings are: the share of the shorter one's words that the other has too. */
export function overlap(a: string, b: string): number {
  const left = wordsKey(a);
  const right = wordsKey(b);
  if (!left.length || !right.length) return 0;
  const [small, large] = left.length <= right.length ? [left, right] : [right, left];
  const pool = new Map<string, number>();
  for (const word of large) pool.set(word, (pool.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of small) {
    const count = pool.get(word) ?? 0;
    if (count > 0) {
      shared++;
      pool.set(word, count - 1);
    }
  }
  return shared / small.length;
}
