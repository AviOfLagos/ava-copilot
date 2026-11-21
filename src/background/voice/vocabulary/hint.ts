import { vocabularyStore } from '@extension/storage';
import type { VocabEntry } from '@extension/storage';
import { byPrecedence, inScope } from '@extension/storage';

const MAX_ENTRIES = 40;
const MAX_CHARS = 600;

/** The sentence that gives the recogniser the user's own words (empty when there are none). Pure: tests pass entries. */
export function hintFromEntries(entries: VocabEntry[], workspaceId: string | null): string {
  const usable = inScope(entries, workspaceId)
    .filter(entry => !entry.never)
    .sort((a, b) => byPrecedence(a, b) || b.uses - a.uses)
    .slice(0, MAX_ENTRIES);
  if (usable.length === 0) return '';
  let list = '';
  for (const entry of usable) {
    const heard = entry.heardAs.length ? ` (not ${entry.heardAs.slice(0, 3).join(', ')})` : '';
    const piece = `${entry.write}${heard}`;
    if (list.length + piece.length + 2 > MAX_CHARS) break;
    list += list ? `; ${piece}` : piece;
  }
  return list ? `These names and terms may be spoken; write them exactly this way: ${list}.` : '';
}

/** The hint for a workspace, from the stored entries. Never throws: with a problem there is no hint. */
export async function vocabularyHint(workspaceId: string | null | undefined): Promise<string> {
  try {
    return hintFromEntries(await vocabularyStore.all(), workspaceId ?? null);
  } catch {
    return '';
  }
}
