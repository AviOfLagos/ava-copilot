import { productStore, vocabularyStore, workspaceStore } from '@extension/storage';
import type { VocabKind } from '@extension/storage';
import { foldWord, phraseWords } from '@extension/storage';
import { isEnglishWord } from './words';

/**
 * The first entries come from names the user already keeps: workspaces, products, and (from the people store, when
 * it exists) people. A seed is a spelling to protect and to match near misses against; the owner's own entries win
 * over it (storage/lib/vocabulary).
 */

export interface Seed {
  key: string;
  write: string;
  kind: VocabKind;
  workspaceId: string | null;
  heardAs?: string[];
}

// Names that every install has, and that say nothing about how a person speaks
const GENERIC = new Set(['my workspace', 'personal', 'default', 'home', 'work']);

/**
 * Whether a name is worth seeding. A name made only of ordinary English words ("Work", "Quiet Hours") cannot be told
 * from the words themselves, so it is never corrected by itself; and a short name fits too many words.
 */
export function worthSeeding(write: string, isWord: (word: string) => boolean = isEnglishWord): boolean {
  const name = write.trim();
  if (!name || GENERIC.has(name.toLowerCase())) return false;
  if (foldWord(name).length < 4) return false;
  return !phraseWords(name).every(word => isWord(word));
}

/** Seeds from workspace and product names. */
export function seedsFromNames(
  workspaces: { id: string; name: string }[],
  products: { workspaceId: string; name: string }[],
  isWord?: (word: string) => boolean,
): { workspaces: Seed[]; products: Seed[] } {
  return {
    workspaces: workspaces
      .filter(workspace => worthSeeding(workspace.name, isWord))
      .map(workspace => ({ key: workspace.id, write: workspace.name, kind: 'name', workspaceId: null })),
    products: products
      .filter(product => worthSeeding(product.name, isWord))
      .map(product => ({
        key: product.workspaceId,
        write: product.name,
        kind: 'product',
        workspaceId: product.workspaceId,
      })),
  };
}

/** Keeps the workspace and product seeds in step with the names now in the stores. */
export async function syncVocabularySeeds(): Promise<void> {
  const [workspaces, products] = await Promise.all([workspaceStore.list(), productStore.all()]);
  const seeds = seedsFromNames(
    workspaces,
    Object.values(products).map(product => ({ workspaceId: product.workspaceId, name: product.name })),
  );
  const dismissed = await dismissedSeeds();
  await vocabularyStore.syncSeeds('workspace', seeds.workspaces, dismissed);
  await vocabularyStore.syncSeeds('product', seeds.products, dismissed);
}

/**
 * For the people store (docs/pm-desk.md, Part 5): a person's name and the other names they go by become seeds, so
 * the recogniser is helped with them too. Call it with every person, and again when anyone is added, renamed or
 * removed: seeds of people no longer in the list are dropped.
 */
export async function addPersonSeeds(
  people: { id: string; name: string; aliases?: string[]; workspaceId?: string | null }[],
): Promise<void> {
  const seeds: Seed[] = [];
  for (const person of people) {
    for (const [index, name] of [person.name, ...(person.aliases ?? [])].entries()) {
      if (!worthSeeding(name)) continue;
      seeds.push({
        key: `${person.id}:${index}`,
        write: name,
        kind: 'person',
        workspaceId: person.workspaceId ?? null,
      });
    }
  }
  await vocabularyStore.syncSeeds('person', seeds, await dismissedSeeds());
}

const DISMISSED_KEY = 'vocab-dismissed-seeds';

/** The seeds the owner removed from the list: they are not added again. */
export async function dismissedSeeds(): Promise<Set<string>> {
  const stored = await chrome.storage.local.get(DISMISSED_KEY);
  return new Set((stored[DISMISSED_KEY] as string[] | undefined) ?? []);
}

export async function dismissSeed(id: string): Promise<void> {
  const all = await dismissedSeeds();
  all.add(id);
  await chrome.storage.local.set({ [DISMISSED_KEY]: [...all].slice(-500) });
}
