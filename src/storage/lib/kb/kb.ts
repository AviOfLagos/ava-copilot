import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb, KnowledgeAnchor, KnowledgeChunk, KnowledgeItem, KnowledgeSourceType } from '../threads/db';

export const KB_EXPORT_FORMAT = 'avi-copilot-kb';
export const KB_EXPORT_VERSION = 1;

export interface KbCitation {
  // The number the answer cites it by
  n: number;
  sourceType: KnowledgeSourceType;
  title: string;
  // Where in the source, e.g. "12:04", "note" or "message 7"
  label: string;
  anchor: KnowledgeAnchor;
  date: number;
  url: string;
}

export interface KbAnswer {
  answer: string;
  citations: KbCitation[];
}

export interface KbExport {
  format: typeof KB_EXPORT_FORMAT;
  version: number;
  exportedAt: number;
  items: KnowledgeItem[];
  chunks: KnowledgeChunk[];
}

/** A stable id per source, so indexing the same chat, meeting or page again replaces it. */
export function kbItemId(sourceType: KnowledgeSourceType, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

/**
 * The knowledge base: items (one per chat, meeting or saved page) and their chunks, over a
 * database that defaults to the extension's own.
 */
export function createKbStore(db: AviCopilotDb = defaultDb) {
  const store = {
    db,

    async items(): Promise<KnowledgeItem[]> {
      return (await db.kbItems.orderBy('sourceDate').reverse().toArray()) as KnowledgeItem[];
    },

    async item(id: string): Promise<KnowledgeItem | undefined> {
      return db.kbItems.get(id);
    },

    async chunks(itemId?: string): Promise<KnowledgeChunk[]> {
      if (itemId) {
        return (await db.kbChunks.where('itemId').equals(itemId).toArray()).sort((a, b) => a.index - b.index);
      }
      return db.kbChunks.toArray();
    },

    /** Replaces an item and all of its chunks in one transaction. */
    async put(item: KnowledgeItem, chunks: KnowledgeChunk[]): Promise<void> {
      await db.transaction('rw', db.kbItems, db.kbChunks, async () => {
        await db.kbChunks.where('itemId').equals(item.id).delete();
        await db.kbChunks.bulkPut(chunks);
        await db.kbItems.put({
          ...item,
          chunkCount: chunks.length,
          unembedded: chunks.filter(chunk => !chunk.vector).length,
        });
      });
    },

    /** Stores embeddings for chunks that already exist, and recounts the ones still missing. */
    async setVectors(updates: { id: string; vector: number[]; embedModel: string }[]): Promise<void> {
      if (updates.length === 0) return;
      await db.transaction('rw', db.kbItems, db.kbChunks, async () => {
        const itemIds = new Set<string>();
        for (const { id, vector, embedModel } of updates) {
          const chunk = await db.kbChunks.get(id);
          if (!chunk) continue;
          await db.kbChunks.update(id, { vector, embedModel });
          itemIds.add(chunk.itemId);
        }
        for (const itemId of itemIds) {
          const unembedded = await db.kbChunks
            .where('itemId')
            .equals(itemId)
            .filter(chunk => !chunk.vector)
            .count();
          await db.kbItems.update(itemId, { unembedded });
        }
      });
    },

    /** Chunks without an embedding for this model: never embedded, or embedded by another model. */
    async needingEmbedding(embedModel: string, limit: number): Promise<KnowledgeChunk[]> {
      return db.kbChunks
        .filter(chunk => !chunk.vector || chunk.embedModel !== embedModel)
        .limit(limit)
        .toArray();
    },

    async remove(id: string): Promise<void> {
      await db.transaction('rw', db.kbItems, db.kbChunks, async () => {
        await db.kbChunks.where('itemId').equals(id).delete();
        await db.kbItems.delete(id);
      });
    },

    /** Removes items whose source is older than the cutoff, and returns how many. */
    async removeOlderThan(cutoff: number): Promise<number> {
      const old = await db.kbItems.where('sourceDate').below(cutoff).primaryKeys();
      for (const id of old) {
        await store.remove(id);
      }
      return old.length;
    },

    async wipe(): Promise<void> {
      await db.transaction('rw', db.kbItems, db.kbChunks, async () => {
        await db.kbChunks.clear();
        await db.kbItems.clear();
      });
    },

    async exportAll(): Promise<KbExport> {
      return {
        format: KB_EXPORT_FORMAT,
        version: KB_EXPORT_VERSION,
        exportedAt: Date.now(),
        items: await db.kbItems.toArray(),
        chunks: await db.kbChunks.toArray(),
      };
    },

    /** Adds the items of an export, replacing items with the same id. Returns how many items. */
    async importAll(data: KbExport): Promise<number> {
      const byItem = new Map<string, KnowledgeChunk[]>();
      for (const chunk of data.chunks) {
        byItem.set(chunk.itemId, [...(byItem.get(chunk.itemId) ?? []), chunk]);
      }
      for (const item of data.items) {
        await store.put(item, byItem.get(item.id) ?? []);
      }
      return data.items.length;
    },
  };
  return store;
}

export type KbStore = ReturnType<typeof createKbStore>;

export const kbStore = createKbStore();
