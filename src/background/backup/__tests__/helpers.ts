import type { Dexie } from 'dexie';
import type { StorageAreaLike } from '../snapshot';

/** chrome.storage.local in memory, with get(null) for "everything", as the snapshot reads it. */
export function memoryArea(initial: Record<string, unknown> = {}): StorageAreaLike & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    map,
    async get(keys: null | string | string[]) {
      const list = keys === null ? [...map.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => map.has(key)).map(key => [key, structuredClone(map.get(key))]));
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value));
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key);
    },
  } as StorageAreaLike & { map: Map<string, unknown> };
}

/** Installs a chrome stub before the stores are imported (call from vi.hoisted). */
export function installChrome(): void {
  const area = () => ({
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
    onChanged: { addListener: () => {} },
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area(), session: area(), onChanged: { addListener: () => {} } },
    runtime: { id: 'test', getManifest: () => ({ version: '0.2.0' }) },
  };
}

/** A vault in memory: names and values, nothing encrypted. */
export function memoryVault(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async refs() {
      return [...values.keys()];
    },
    async get(ref: string) {
      return values.get(ref) ?? null;
    },
    async put(ref: string, value: string) {
      values.set(ref, value);
    },
    async delete(ref: string) {
      values.delete(ref);
    },
  };
}

/** One or two rows in every table of a database, keyed by its own primary key, with a Blob where one fits. */
export async function fillEveryTable(db: Dexie, tag = 'a'): Promise<void> {
  for (const table of db.tables) {
    const keyPath = table.schema.primKey.keyPath as string;
    const rows = [1, 2].map(n => ({
      [keyPath]: `${table.name}-${tag}-${n}`,
      key: `${table.name}-key-${tag}-${n}`,
      source: 'test',
      externalId: `${tag}-${n}`,
      threadId: `thread-${tag}`,
      seq: n,
      updatedAt: 1_700_000_000_000 + n,
      note: { $nex: 'not a tag', nested: [1, 'two', null] },
      ...(table.name === 'messages'
        ? {
            attachments: [
              {
                id: `att-${n}`,
                kind: 'image',
                thumb: new Blob([new Uint8Array([1, 2, 3, n])], { type: 'image/jpeg' }),
              },
            ],
          }
        : {}),
      ...(table.name === 'kbChunks' ? { vector: [0.1, -0.25, 0.5 * n], embedModel: 'test-embed' } : {}),
    }));
    await table.bulkPut(rows);
  }
}
