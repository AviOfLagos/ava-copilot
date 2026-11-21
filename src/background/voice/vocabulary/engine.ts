import { byPrecedence, foldWord, inScope, phraseWords } from '@extension/storage';
import type { VocabEntry } from '@extension/storage';
import { doubleMetaphone } from './metaphone';

/**
 * The correction itself, plain code with no model and no storage (docs/pm-desk.md, Part 4.2). One left-to-right pass:
 *
 * 1. Known mishearings: a `heardAs` phrase of one to three words, matched on whole words in any letter case.
 * 2. Near misses: a word or a pair of words of four letters or more that is close to exactly one entry's spelling,
 *    by edit distance (1 up to five letters, else 2) or by the same Double Metaphone code. A real English word is
 *    never changed: it is reported as `unsure`. So is a word that is close to two entries.
 *
 * Every change says what it replaced and where it now stands in the new text, so it can be shown and undone.
 */

export interface VocabChange {
  from: string;
  to: string;
  // Where the new words start in the corrected text
  at: number;
  stage: 'known' | 'near';
  entryId: string;
}

export interface VocabUnsure {
  word: string;
  // Where the word stands in the corrected text
  at: number;
  // What it might have been meant as
  options: string[];
}

export interface CorrectionResult {
  text: string;
  changes: VocabChange[];
  unsure: VocabUnsure[];
}

export interface EngineOptions {
  workspaceId?: string | null;
  isWord: (word: string) => boolean;
  // Words to leave alone, lower case
  keep?: Set<string>;
}

interface Token {
  lower: string;
  start: number;
  end: number;
}

const MIN_NEAR_LETTERS = 4;
// A sound code shorter than this fits too many words
const MIN_CODE = 3;
// Between the words of a phrase heard as one: spaces, and the dots and dashes of "L.M."
const PHRASE_GAP = /^[ \t.\-]+$/;
const PHRASE_GAP_NO_DOTS = /^[ \t\-]+$/;
const PAIR_GAP = /^[ \t]+$/;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    tokens.push({
      lower: foldWord(match[0]),
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return tokens;
}

/** Edit distance (insert, delete, change one letter, swap two neighbours), cut off once it passes `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let twoBack: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, twoBack[j - 2] + 1);
      row.push(value);
    }
    twoBack = previous;
    previous = row;
  }
  return previous[b.length];
}

/**
 * Whether a heard word is close enough to an entry's spelling to be taken for it: within 1 edit up to five letters and
 * 2 edits above; or the same Double Metaphone code (of three characters or more), when it is also within 2 edits, so
 * that "Illem" is taken for "Ellum" and "Ollama" is not.
 */
export function isNear(heard: string, spelling: string): boolean {
  if (heard === spelling) return false;
  const limit = heard.length <= 5 ? 1 : 2;
  const distance = editDistance(heard, spelling, 2);
  if (distance <= limit) return true;
  if (distance > 2) return false;
  const a = doubleMetaphone(heard).primary;
  return a.length >= MIN_CODE && a === doubleMetaphone(spelling).primary;
}

interface Known {
  words: string[];
  endsWithDot: boolean;
  // Only a phrase written with dots ("L.M.") may be heard across one
  hasDots: boolean;
  entry: VocabEntry;
}

export function correctWithEntries(text: string, allEntries: VocabEntry[], options: EngineOptions): CorrectionResult {
  const entries = inScope(allEntries, options.workspaceId ?? null)
    .filter(entry => !entry.never)
    .sort(byPrecedence);
  const keep = options.keep ?? new Set<string>();
  const result: CorrectionResult = { text, changes: [], unsure: [] };
  if (!text.trim() || entries.length === 0) return result;

  // Known mishearings, the longest phrase first; the first entry in precedence order wins
  const known: Known[] = entries
    .flatMap(entry => entry.heardAs.map(phrase => ({ phrase, entry })))
    .map(({ phrase, entry }) => ({
      words: phraseWords(phrase),
      endsWithDot: /\.\s*$/.test(phrase),
      hasDots: phrase.includes('.'),
      entry,
    }))
    .filter(item => item.words.length > 0 && item.words.length <= 3)
    .sort((a, b) => b.words.length - a.words.length);

  // One candidate spelling per distinct folded spelling, the winning entry's
  const spellings = new Map<string, VocabEntry>();
  // Names of people that were only seeded protect their spelling but are not matched against near misses: a
  // name that is one letter off is far more often another person than a mishearing
  const nearSpellings = new Map<string, VocabEntry>();
  for (const entry of entries) {
    const key = foldWord(entry.write);
    if (key.length === 0) continue;
    if (!spellings.has(key)) spellings.set(key, entry);
    if (!nearSpellings.has(key) && !(entry.kind === 'person' && entry.learnedFrom === 'seed'))
      nearSpellings.set(key, entry);
  }

  const tokens = tokenize(text);
  let out = '';
  let cursor = 0;

  const gapOk = (from: Token, to: Token, pattern: RegExp) => pattern.test(text.slice(from.end, to.start));

  for (let i = 0; i < tokens.length;) {
    // 1. Known mishearings
    let matched: { known: Known; length: number } | null = null;
    for (const item of known) {
      const n = item.words.length;
      if (i + n > tokens.length) continue;
      let fits = true;
      for (let k = 0; k < n && fits; k++) {
        if (tokens[i + k].lower !== item.words[k]) fits = false;
        else if (k > 0 && !gapOk(tokens[i + k - 1], tokens[i + k], item.hasDots ? PHRASE_GAP : PHRASE_GAP_NO_DOTS))
          fits = false;
      }
      if (!fits) continue;
      if (item.words.every(word => keep.has(word))) continue;
      matched = { known: item, length: n };
      break;
    }
    if (matched) {
      const first = tokens[i];
      const lastToken = tokens[i + matched.length - 1];
      let end = lastToken.end;
      if (matched.known.endsWithDot && text[end] === '.') end += 1;
      const from = text.slice(first.start, end);
      out += text.slice(cursor, first.start);
      if (from !== matched.known.entry.write) {
        result.changes.push({
          from,
          to: matched.known.entry.write,
          at: out.length,
          stage: 'known',
          entryId: matched.known.entry.id,
        });
      }
      out += matched.known.entry.write;
      cursor = end;
      i += matched.length;
      continue;
    }

    // 2. Near misses: this word, else this word and the next as one
    const here = tokens[i];
    const next = tokens[i + 1];
    const candidates: { folded: string; length: number }[] = [{ folded: here.lower, length: 1 }];
    // Two words heard as one name. Not two ordinary words ("quill and" is not "Quillon"), not a short word in front
    // of a name that is already right ("an Ellum"), and a short word only when neither is a real word
    if (next && gapOk(here, next, PAIR_GAP) && !spellings.has(next.lower) && !spellings.has(here.lower)) {
      const real = [options.isWord(here.lower), options.isWord(next.lower)];
      const short = here.lower.length < 3 || next.lower.length < 3;
      if (!(real[0] && real[1]) && !(short && (real[0] || real[1]))) {
        candidates.push({ folded: here.lower + next.lower, length: 2 });
      }
    }

    // How many words this step used up
    let used = 1;
    for (const candidate of candidates) {
      // Already written right: nothing to change, and nothing to suggest for this word
      const exact = spellings.get(candidate.folded);
      if (exact && candidate.length === 1) break;
      if (candidate.folded.length < MIN_NEAR_LETTERS) continue;
      if (candidate.length === 1 && keep.has(candidate.folded)) continue;
      if (exact) {
        // Two words that join into a spelling ("El lum"): written as it, unless that is how they were written
        const lastWord = tokens[i + 1];
        const from = text.slice(here.start, lastWord.end);
        out += text.slice(cursor, here.start);
        if (from !== exact.write) {
          result.changes.push({ from, to: exact.write, at: out.length, stage: 'near', entryId: exact.id });
        }
        out += exact.write;
        cursor = lastWord.end;
        used = 2;
        break;
      }
      const close = [...nearSpellings]
        .filter(([spelling]) => isNear(candidate.folded, spelling))
        .map(([, entry]) => entry);
      if (close.length === 0) continue;
      const last = tokens[i + candidate.length - 1];
      const from = text.slice(here.start, last.end);
      if (close.length > 1 || options.isWord(candidate.folded)) {
        result.unsure.push({
          word: from,
          at: out.length + (here.start - cursor),
          options: close.map(entry => entry.write),
        });
        // A word left as it is is settled; a pair left as it is leaves its first word to be looked at alone
        if (candidate.length === 1) break;
        continue;
      }
      out += text.slice(cursor, here.start);
      result.changes.push({ from, to: close[0].write, at: out.length, stage: 'near', entryId: close[0].id });
      out += close[0].write;
      cursor = last.end;
      used = candidate.length;
      break;
    }
    i += used;
  }
  out += text.slice(cursor);
  result.text = out;
  return result;
}
