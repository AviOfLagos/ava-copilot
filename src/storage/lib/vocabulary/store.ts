import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb } from '../threads/db';
import { byPrecedence, foldWord, phraseWords } from './types';
import type { VocabEntry, VocabKind, VocabSource } from './types';

export interface VocabInput {
  write: string;
  heardAs?: string[];
  kind?: VocabKind;
  workspaceId?: string | null;
  learnedFrom?: VocabSource;
  never?: boolean;
}

const MAX_WRITE = 60;
const MAX_HEARD = 12;

/** A phrase as it is stored: single spaces, trimmed, cut short. */
function tidy(value: string, max = MAX_WRITE): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The vocabulary over a database that defaults to the extension's own. Tests pass their own database. Adding an
 * entry for a spelling that already has one adds what was heard to it, and an owner's entry is never replaced by a
 * seed or a learned one.
 */
export function createVocabularyStore(db: AviCopilotDb = defaultDb) {
  return {
    db,

    async all(): Promise<VocabEntry[]> {
      return db.vocabulary.toArray();
    },

    /** Adds an entry, or what was heard to the entry that already writes it that way in the same scope. */
    async add(input: VocabInput, now = Date.now()): Promise<VocabEntry | null> {
      const write = tidy(input.write);
      if (foldWord(write).length < 2) return null;
      const workspaceId = input.workspaceId ?? null;
      const learnedFrom = input.learnedFrom ?? 'avi';
      const heard = [...new Set((input.heardAs ?? []).map(phrase => tidy(phrase)).filter(Boolean))].slice(0, MAX_HEARD);
      const same = (await db.vocabulary.toArray()).filter(
        entry =>
          foldWord(entry.write) === foldWord(write) &&
          entry.workspaceId === workspaceId &&
          Boolean(entry.never) === Boolean(input.never),
      );
      const found = same.sort(byPrecedence)[0];
      if (found) {
        // A seed never touches an entry that is the owner's or learned
        if (learnedFrom === 'seed' && found.learnedFrom !== 'seed') return found;
        const merged = [...new Set([...found.heardAs, ...heard])].slice(0, MAX_HEARD);
        const next: VocabEntry = {
          ...found,
          // The owner's spelling of it wins, a seed's does not
          write: learnedFrom === 'seed' && found.learnedFrom === 'seed' ? write : found.write,
          heardAs: merged,
          kind: input.kind ?? found.kind,
          // A learned entry the owner then typed himself becomes his
          learnedFrom: learnedFrom === 'avi' ? 'avi' : found.learnedFrom,
        };
        await db.vocabulary.put(next);
        return next;
      }
      const entry: VocabEntry = {
        id: crypto.randomUUID(),
        write,
        heardAs: input.never ? [] : heard,
        kind: input.kind ?? 'term',
        workspaceId,
        learnedFrom,
        uses: 0,
        createdAt: now,
        ...(input.never ? { never: true } : {}),
      };
      await db.vocabulary.add(entry);
      return entry;
    },

    /** Changes an entry from the settings screen; what the owner edits becomes the owner's. */
    async update(
      id: string,
      changes: Partial<Pick<VocabEntry, 'write' | 'heardAs' | 'kind' | 'workspaceId'>>,
    ): Promise<VocabEntry | null> {
      const entry = await db.vocabulary.get(id);
      if (!entry) return null;
      const next: VocabEntry = {
        ...entry,
        ...(changes.write !== undefined ? { write: tidy(changes.write) } : {}),
        ...(changes.heardAs !== undefined
          ? { heardAs: [...new Set(changes.heardAs.map(phrase => tidy(phrase)).filter(Boolean))].slice(0, MAX_HEARD) }
          : {}),
        ...(changes.kind ? { kind: changes.kind } : {}),
        ...(changes.workspaceId !== undefined ? { workspaceId: changes.workspaceId } : {}),
        learnedFrom: 'avi',
      };
      if (foldWord(next.write).length < 2) return null;
      await db.vocabulary.put(next);
      return next;
    },

    async remove(id: string): Promise<void> {
      await db.vocabulary.delete(id);
    },

    /** Counts the entries that changed a word, once per change. */
    async countUses(ids: string[]): Promise<void> {
      const counts = new Map<string, number>();
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      await db.transaction('rw', db.vocabulary, async () => {
        for (const [id, count] of counts) {
          const entry = await db.vocabulary.get(id);
          if (entry) await db.vocabulary.put({ ...entry, uses: entry.uses + count });
        }
      });
    },

    /**
     * Keeps the seeds in step with the names they come from: adds the new, and removes seeds whose source is gone.
     * `source` names the group ('workspace', 'product', 'person') so one group never removes another's seeds.
     */
    async syncSeeds(
      group: string,
      seeds: { key: string; write: string; kind: VocabKind; workspaceId: string | null; heardAs?: string[] }[],
    ): Promise<void> {
      const mine = (id: string) => id.startsWith(`seed:${group}:`);
      const wanted = new Map(seeds.map(seed => [`seed:${group}:${seed.key}`, seed]));
      await db.transaction('rw', db.vocabulary, async () => {
        for (const entry of await db.vocabulary.toArray()) {
          if (entry.learnedFrom === 'seed' && mine(entry.id) && !wanted.has(entry.id)) {
            await db.vocabulary.delete(entry.id);
          }
        }
        for (const [id, seed] of wanted) {
          const existing = await db.vocabulary.get(id);
          const heardAs = [...new Set([...(existing?.heardAs ?? []), ...(seed.heardAs ?? [])])].slice(0, MAX_HEARD);
          await db.vocabulary.put({
            id,
            write: tidy(seed.write),
            heardAs,
            kind: seed.kind,
            workspaceId: seed.workspaceId,
            learnedFrom: 'seed',
            uses: existing?.uses ?? 0,
            createdAt: existing?.createdAt ?? Date.now(),
          });
        }
      });
    },

    /** Words that must be left alone, lower case. */
    async keepWords(): Promise<Set<string>> {
      const keep = new Set<string>();
      for (const entry of await db.vocabulary.toArray())
        if (entry.never) phraseWords(entry.write).forEach(w => keep.add(w));
      return keep;
    },
  };
}

export type VocabularyStore = ReturnType<typeof createVocabularyStore>;
export const vocabularyStore = createVocabularyStore();
