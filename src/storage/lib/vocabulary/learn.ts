import { foldWord } from './types';

/**
 * Learning from an edit in the composer (docs/pm-desk.md, Part 4.4): the dictated text before and after the edit.
 * When the edit replaced one word or one short phrase with another, and nothing else changed, that is a rule
 * the user may want kept. Plain code on words, no model.
 */

export interface SuggestedRule {
  from: string;
  to: string;
}

const MAX_WORDS = 3;

const wordsOf = (text: string): string[] => text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu) ?? [];
const clean = (word: string) => word.replace(/^[.\-'’]+|[.\-'’]+$/g, '');

/**
 * The one replacement that turns `before` into `after`, or null: what stays at the start and at the end is
 * matched, and what is left in the middle must be one to three words on each side. A word that only changed
 * capital letters or punctuation is not a rule.
 */
export function suggestRule(before: string, after: string): SuggestedRule | null {
  const a = wordsOf(before).map(clean).filter(Boolean);
  const b = wordsOf(after).map(clean).filter(Boolean);
  const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  let start = 0;
  while (start < a.length && start < b.length && same(a[start], b[start])) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && same(a[endA - 1], b[endB - 1])) {
    endA -= 1;
    endB -= 1;
  }
  const from = a.slice(start, endA);
  const to = b.slice(start, endB);
  if (from.length === 0 || to.length === 0) return null;
  if (from.length > MAX_WORDS || to.length > MAX_WORDS) return null;
  if (from.join(' ').toLowerCase() === to.join(' ').toLowerCase()) return null;
  // A rewrite of a sentence is not a spelling: only a change that keeps some of the sound is a rule
  if (foldWord(from.join('')).length < 2 || foldWord(to.join('')).length < 2) return null;
  return { from: from.join(' '), to: to.join(' ') };
}

/**
 * "E-L-L-U-M", "e l l u m" or "E.L.L.U.M." as the word they spell, in capitals at the start: "Ellum".
 * Anything else comes back as it was.
 */
export function spelledOut(value: string): string {
  const trimmed = value.trim();
  const letters = trimmed.split(/[\s.\-,]+/).filter(Boolean);
  if (letters.length >= 2 && letters.every(letter => /^\p{L}$/u.test(letter))) {
    const word = letters.join('');
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return trimmed;
}
