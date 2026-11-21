import { vocabularyStore } from '@extension/storage';
import type { VocabEntry } from '@extension/storage';
import { createLogger } from '../../log';
import { correctWithEntries } from './engine';
import type { CorrectionResult } from './engine';
import { syncVocabularySeeds } from './seeds';
import { isEnglishWord } from './words';

export type { CorrectionResult, VocabChange, VocabUnsure } from './engine';
export { addPersonSeeds, syncVocabularySeeds } from './seeds';
export { vocabularyHint } from './hint';

const logger = createLogger('Vocabulary');

export interface CorrectDeps {
  entries: () => Promise<VocabEntry[]>;
  keep: () => Promise<Set<string>>;
  countUses: (ids: string[]) => Promise<void>;
  sync: () => Promise<void>;
  isWord: (word: string) => boolean;
}

const storeDeps: CorrectDeps = {
  entries: () => vocabularyStore.all(),
  keep: () => vocabularyStore.keepWords(),
  countUses: ids => vocabularyStore.countUses(ids),
  sync: syncOften,
  isWord: isEnglishWord,
};

// The seeds follow the workspaces, products and people: looked at again at most once a minute
let lastSync = 0;
async function syncOften(): Promise<void> {
  if (Date.now() - lastSync < 60_000) return;
  lastSync = Date.now();
  await syncVocabularySeeds();
}

/**
 * Corrects what the recogniser wrote, with the words the user taught it (docs/pm-desk.md, Part 4). Called once at
 * each place speech becomes final text. It never throws and never loses the words: with a problem, the text comes
 * back as it was.
 */
export async function correctTranscript(
  text: string,
  options: { workspaceId?: string | null } = {},
  deps: CorrectDeps = storeDeps,
): Promise<CorrectionResult> {
  const unchanged: CorrectionResult = { text, changes: [], unsure: [] };
  if (!text.trim()) return unchanged;
  try {
    await deps.sync().catch(() => {});
    const [entries, keep] = await Promise.all([deps.entries(), deps.keep()]);
    const result = correctWithEntries(text, entries, {
      workspaceId: options.workspaceId ?? null,
      isWord: deps.isWord,
      keep,
    });
    if (result.changes.length > 0) await deps.countUses(result.changes.map(change => change.entryId)).catch(() => {});
    return result;
  } catch (error) {
    logger.warning('Could not correct the words', error instanceof Error ? error.message : String(error));
    return unchanged;
  }
}

/** Just the corrected text, for places that need nothing more. */
export async function correctedText(text: string, options: { workspaceId?: string | null } = {}): Promise<string> {
  return (await correctTranscript(text, options)).text;
}
