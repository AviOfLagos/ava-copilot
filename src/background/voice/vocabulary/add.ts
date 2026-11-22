import { checkHeardAs, foldWord, phraseWords, spelledOut, vocabularyStore } from '@extension/storage';
import type { VocabKind, VocabSource, VocabularyStore } from '@extension/storage';
import { isEnglishWord } from './words';

export interface AddInput {
  write: string;
  heardAs?: string[];
  kind?: VocabKind;
  workspaceId?: string | null;
  learnedFrom?: VocabSource;
}

export interface AddResult {
  ok: boolean;
  // A plain sentence, for the user and for the voice and chat answers
  message: string;
  saved: string[];
  refused: string[];
}

/**
 * Saves a spelling and what it is heard as. Said by the owner (`avi`) or accepted from a correction. What
 * is heard must be at least two letters and at most three words, and an ordinary English word is accepted only
 * from the owner himself. The spelling comes back from "E-L-L-U-M" as "Ellum".
 */
export async function addVocabulary(
  input: AddInput,
  store: Pick<VocabularyStore, 'add'> = vocabularyStore,
  isWord: (word: string) => boolean = isEnglishWord,
): Promise<AddResult> {
  const write = spelledOut(input.write);
  const learnedFrom = input.learnedFrom ?? 'avi';
  if (foldWord(write).length < 2) {
    return { ok: false, message: 'I need the word spelled out, at least two letters.', saved: [], refused: [] };
  }
  const saved: string[] = [];
  const refused: string[] = [];
  for (const raw of input.heardAs ?? []) {
    const problem = checkHeardAs(spelledOut(raw), write, learnedFrom, isWord);
    if (problem === null) saved.push(spelledOut(raw));
    else refused.push(raw);
  }
  const entry = await store.add({
    write,
    heardAs: saved,
    kind: input.kind ?? (phraseWords(write).length > 1 ? 'term' : 'name'),
    workspaceId: input.workspaceId ?? null,
    learnedFrom,
  });
  if (!entry) return { ok: false, message: 'I could not save that.', saved: [], refused };
  const parts = [`I will write "${write}" from now on.`];
  if (saved.length) parts.push(`When I hear ${saved.map(word => `"${word}"`).join(' or ')}, it becomes "${write}".`);
  if (refused.length) {
    parts.push(
      `I did not keep ${refused.map(word => `"${word}"`).join(', ')}: it is an ordinary word, one letter or the same as the spelling, so I would change words you meant.`,
    );
  }
  return { ok: true, message: parts.join(' '), saved, refused };
}

/**
 * Whether the user's own words contain what is to be saved: the spelling, and what it was heard as when that is given.
 * A page or a call cannot make the user say a word, so this is what stops them steering the vocabulary. Spelled
 * out ("E L L U M") counts, since letters are compared and not spacing.
 */
export function saidByUser(said: string, write: string, heardAs: string[] = []): boolean {
  const heard = foldWord(said);
  return [write, ...heardAs].every(word => {
    const folded = foldWord(spelledOut(word));
    return folded.length > 0 && heard.includes(folded);
  });
}

export const NOT_SAID = 'I only change how I write a word when you say it to me yourself, so I have not saved that.';
