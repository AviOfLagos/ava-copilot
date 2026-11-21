/**
 * Words the speech recogniser gets wrong, and how to write them (docs/pm-desk.md, Part 4). One table, read by the
 * background's correction and by the settings screen; the background is the only writer.
 */

export type VocabKind = 'name' | 'product' | 'person' | 'term';
// 'avi': typed or said by the owner. 'correction': learned from an edit in the composer. 'seed': copied from a
// workspace, a product or a person. The owner's own entries win over seeds.
export type VocabSource = 'avi' | 'correction' | 'seed';

export interface VocabEntry {
  id: string;
  // The right spelling: "Ellum"
  write: string;
  // What the recogniser writes instead: "Illum", "Elum", "L.M."
  heardAs: string[];
  kind: VocabKind;
  // null means everywhere
  workspaceId: string | null;
  learnedFrom: VocabSource;
  // How often it changed a word
  uses: number;
  createdAt: number;
  // "Never change this word": `write` is a word the correction must leave alone. Such an entry has no `heardAs`.
  never?: boolean;
}

export const VOCAB_KINDS: VocabKind[] = ['name', 'product', 'person', 'term'];

/** Letters and digits only, lower case: how two spellings are compared. */
export function foldWord(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The words of a phrase, lower case, punctuation gone: "L.M." is ["l", "m"]. */
export function phraseWords(phrase: string): string[] {
  return (
    phrase
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** How many letters a heard phrase has once punctuation is removed. */
export function letterCount(phrase: string): number {
  return foldWord(phrase).length;
}

export type HeardAsProblem = 'tooShort' | 'tooLong' | 'ordinaryWord' | 'sameAsWrite';

/**
 * Whether `phrase` may be kept as something heard instead of `write`. At least two letters once punctuation is
 * removed; no more than three words; and when it is an ordinary English word, only the owner's own entries may
 * say so (`isWord` answers that; the list lives in the background).
 */
export function checkHeardAs(
  phrase: string,
  write: string,
  learnedFrom: VocabSource,
  isWord: (word: string) => boolean,
): HeardAsProblem | null {
  const words = phraseWords(phrase);
  if (letterCount(phrase) < 2) return 'tooShort';
  if (words.length > 3) return 'tooLong';
  if (words.join(' ') === phraseWords(write).join(' ')) return 'sameAsWrite';
  if (learnedFrom !== 'avi' && words.length === 1 && isWord(words[0])) return 'ordinaryWord';
  return null;
}

/** Entries in the order they win: the owner's, then corrections, then seeds; one for a workspace before one for everywhere. */
export function byPrecedence(a: VocabEntry, b: VocabEntry): number {
  const rank = (entry: VocabEntry) => ({ avi: 0, correction: 1, seed: 2 })[entry.learnedFrom];
  return (
    rank(a) - rank(b) || Number(a.workspaceId === null) - Number(b.workspaceId === null) || a.createdAt - b.createdAt
  );
}

/** The entries that apply in a workspace: those for it and those for everywhere. */
export function inScope(entries: VocabEntry[], workspaceId: string | null): VocabEntry[] {
  return entries.filter(entry => entry.workspaceId === null || entry.workspaceId === workspaceId);
}
