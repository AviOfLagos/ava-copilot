import { z } from 'zod';
import type { Dexie, IndexableType, Table } from 'dexie';
import { AppError } from '@extension/shared';
import { BACKUP_MAX_BYTES } from '@src/shared/lib/protocol/companion';
import { decodeValue, encodeValue, gunzip, gzip, isGzip } from './codec';

/**
 * A snapshot of everything Nex Copilot keeps on this browser that an uninstall would wipe: every table of the
 * database and every key of `chrome.storage.local`, found by listing them (so a table or a store added later is
 * in the next snapshot without anyone remembering to add it), minus the short deny-lists below. API keys and
 * sign-ins are never in it: they go to the Mac's Keychain separately (./service.ts).
 *
 * Not in a snapshot, on purpose:
 * - `chrome.storage.session`: it is cleared whenever the browser closes (job hand-offs, open places, the
 *   breaker, reminders already shown).
 * - OPFS: the downloaded voice and wake-word models, which download again.
 * - The "avi-vault" and "avi-history" databases: the Obsidian and AI-history folders the user picked are
 *   browser permissions (FileSystemDirectoryHandle), which cannot be carried; they are picked again.
 * - The secrets vault ("avi-secrets"): its key cannot leave the browser; its values travel through the
 *   Keychain instead, and the Nex Brain pairing token never does (pairing again proves the user is at the Mac).
 * - The search index: it is in memory and rebuilt from the knowledge tables on start. Embeddings are stored in
 *   `kbChunks` and are kept, since making them again costs model calls.
 */

export const SNAPSHOT_FORMAT = 'nex-copilot-backup';
export const SNAPSHOT_FORMAT_VERSION = 1;
// The JSON of a snapshot must fit in one string to be read back
export const MAX_SNAPSHOT_JSON_BYTES = 480 * 1024 * 1024;

/** Tables left out, why, and what a restore does with the copy already on this browser. */
export const EXCLUDED_TABLES: Record<string, { reason: string; onRestore: 'keep' | 'clear' }> = {
  logs: { reason: 'Diagnostics of the last days, nothing the user made.', onRestore: 'keep' },
  audioChunks: {
    reason: 'Raw recording audio waiting to be transcribed, deleted once it is; the transcript is kept.',
    onRestore: 'clear',
  },
  modelCatalog: { reason: "The providers' model lists, read again from each provider.", onRestore: 'keep' },
};

/** Keys of chrome.storage.local left out: state of this install, not the user's memory or settings. */
export const EXCLUDED_STORAGE_KEYS: Record<string, string> = {
  'brain-settings': 'Pairing with Nex Brain: a reinstall pairs again, which proves the user is at the Mac.',
  'brain-status': "Nex Brain's last health check.",
  'backup-status': 'How the last backup went.',
  'meet-voice-state': "Ava's live state in a call.",
  'calendar-upcoming': 'Calendar events read ahead; read again.',
  'model-health': 'Which model calls failed lately; measured again.',
  'capabilities-panel': "The panel's list of places, written when the panel starts.",
  'vault-state': 'Whether an Obsidian folder is connected: the folder itself is a browser permission, picked again.',
};

export const isExcludedStorageKey = (key: string): boolean => Object.hasOwn(EXCLUDED_STORAGE_KEYS, key);

export interface StorageAreaLike {
  get(keys: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

const tableNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const rowSchema = z.custom<Record<string, unknown>>(
  value => typeof value === 'object' && value !== null && !Array.isArray(value),
  'A row must be an object.',
);

export const snapshotSchema = z.object({
  format: z.literal(SNAPSHOT_FORMAT),
  formatVersion: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  extensionVersion: z.string().max(40),
  counts: z.record(z.string().max(64), z.number().int().nonnegative()),
  storage: z.record(z.string().min(1).max(200), z.unknown()),
  // Whether any storage value carries tagged values (./codec.ts)
  storageEncoded: z.boolean(),
  db: z.object({
    name: z.string().max(100),
    version: z.number().int().positive().max(100_000),
    // Each table's Dexie schema at that version, e.g. "id, threadId, [threadId+seq]"
    schema: z.record(
      tableNameSchema,
      z
        .string()
        .max(1000)
        .regex(/^[\w$[\]+&*,:. ]*$/),
    ),
    tables: z.record(tableNameSchema, z.array(rowSchema)),
    // The tables whose rows carry tagged values
    encoded: z.array(tableNameSchema),
  }),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export interface SnapshotSource {
  db: Dexie;
  storage: Pick<StorageAreaLike, 'get'>;
  extensionVersion: string;
  now?: () => number;
}

export interface BuiltSnapshot {
  // The gzipped JSON
  bytes: Uint8Array<ArrayBuffer>;
  jsonBytes: number;
  createdAt: number;
  dbVersion: number;
  counts: Record<string, number>;
}

const PAGE = 500;

/** Every table's Dexie schema string, as `version().stores()` takes it. */
export function tableSchemas(db: Dexie): Record<string, string> {
  return Object.fromEntries(
    db.tables.map(table => [
      table.name,
      [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(', '),
    ]),
  );
}

/** The tables a snapshot covers: all of them but the excluded ones. */
export function snapshotTables(db: Dexie): Table[] {
  return db.tables.filter(table => !Object.hasOwn(EXCLUDED_TABLES, table.name));
}

/** A table's rows in pages by primary key, so a big table is never read in one go. */
async function* pages(table: Table): AsyncGenerator<unknown[]> {
  let keys = (await table.orderBy(':id').limit(PAGE).primaryKeys()) as IndexableType[];
  while (keys.length) {
    yield (await table.bulkGet(keys)).filter(row => row !== undefined);
    if (keys.length < PAGE) return;
    keys = (await table
      .where(':id')
      .above(keys[keys.length - 1])
      .limit(PAGE)
      .primaryKeys()) as IndexableType[];
  }
}

/**
 * Builds the snapshot as JSON in parts (never one string the size of the whole database), then gzips it.
 * Reads are not one transaction (reading a Blob would end it), so a write during a backup may land in it or not.
 */
export async function buildSnapshot(source: SnapshotSource): Promise<BuiltSnapshot> {
  const createdAt = (source.now ?? Date.now)();
  const parts: string[] = [];
  const counts: Record<string, number> = {};
  const encoded: string[] = [];
  let size = 0;
  const push = (text: string) => {
    size += text.length;
    if (size > MAX_SNAPSHOT_JSON_BYTES) {
      throw new AppError('invalid', 'This browser holds more than one backup can carry (about 480 MB).', {
        retryable: false,
      });
    }
    parts.push(text);
  };

  push('{"db":{"tables":{');
  let firstTable = true;
  for (const table of snapshotTables(source.db)) {
    push(`${firstTable ? '' : ','}${JSON.stringify(table.name)}:[`);
    firstTable = false;
    let count = 0;
    let tagged = false;
    for await (const rows of pages(table)) {
      for (const row of rows) {
        const value = await encodeValue(row);
        if (value !== row) tagged = true;
        push(`${count ? ',' : ''}${JSON.stringify(value)}`);
        count += 1;
      }
    }
    push(']');
    counts[table.name] = count;
    if (tagged) encoded.push(table.name);
  }

  const area = await source.storage.get(null);
  const storage: Record<string, unknown> = {};
  let storageEncoded = false;
  for (const [key, value] of Object.entries(area)) {
    if (isExcludedStorageKey(key)) continue;
    const kept = await encodeValue(value);
    if (kept !== value) storageEncoded = true;
    storage[key] = kept;
  }
  counts.storageKeys = Object.keys(storage).length;

  const schema = tableSchemas(source.db);
  push(
    `},"name":${JSON.stringify(source.db.name)},"version":${source.db.verno},"schema":${JSON.stringify(
      Object.fromEntries(Object.entries(schema).filter(([name]) => !Object.hasOwn(EXCLUDED_TABLES, name))),
    )},"encoded":${JSON.stringify(encoded)}}`,
  );
  push(
    `,"format":${JSON.stringify(SNAPSHOT_FORMAT)},"formatVersion":${SNAPSHOT_FORMAT_VERSION},"createdAt":${createdAt}` +
      `,"extensionVersion":${JSON.stringify(source.extensionVersion.slice(0, 40))},"counts":${JSON.stringify(counts)}` +
      `,"storageEncoded":${storageEncoded},"storage":${JSON.stringify(storage)}}`,
  );

  const json = new Blob(parts, { type: 'application/json' });
  const bytes = (await gzip(json, BACKUP_MAX_BYTES + 1)) as Uint8Array<ArrayBuffer>;
  if (bytes.length > BACKUP_MAX_BYTES) {
    throw new AppError('invalid', 'This backup is larger than 256 MB once compressed.', { retryable: false });
  }
  return { bytes, jsonBytes: json.size, createdAt, dbVersion: source.db.verno, counts };
}

export const NEWER_SNAPSHOT_MESSAGE =
  'This backup comes from a newer version of Nex Copilot. Update the extension, then restore it.';

/**
 * Reads a snapshot from gzipped or plain JSON bytes: size-limited, schema-checked, nothing in it run.
 * Values are decoded (Blobs, dates) only where the snapshot says they were encoded.
 */
export async function parseSnapshot(input: Uint8Array<ArrayBuffer>): Promise<Snapshot> {
  if (input.length > BACKUP_MAX_BYTES && isGzip(input)) {
    throw new AppError('invalid', 'This backup file is larger than 256 MB.', { retryable: false });
  }
  if (!isGzip(input) && input.length > MAX_SNAPSHOT_JSON_BYTES) {
    throw new AppError('invalid', 'This backup file is larger than 480 MB.', { retryable: false });
  }
  const bytes = isGzip(input) ? await gunzip(input, MAX_SNAPSHOT_JSON_BYTES) : input;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError('invalid', 'This file is not a Nex Copilot backup.', { retryable: false });
  }
  return checkSnapshot(raw);
}

/** A parsed value as a snapshot, or a plain sentence saying why it is not one. */
export function checkSnapshot(raw: unknown): Snapshot {
  const format = (raw as { format?: unknown; formatVersion?: unknown } | null) ?? {};
  if (format.format === SNAPSHOT_FORMAT && Number(format.formatVersion) > SNAPSHOT_FORMAT_VERSION) {
    throw new AppError('invalid', NEWER_SNAPSHOT_MESSAGE, { retryable: false });
  }
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('invalid', 'This file is not a Nex Copilot backup, or it is damaged.', { retryable: false });
  }
  const snapshot = parsed.data;
  const encoded = new Set(snapshot.db.encoded);
  for (const [name, rows] of Object.entries(snapshot.db.tables)) {
    if (encoded.has(name)) snapshot.db.tables[name] = rows.map(row => decodeValue(row) as Record<string, unknown>);
  }
  if (snapshot.storageEncoded) snapshot.storage = decodeValue(snapshot.storage) as Record<string, unknown>;
  return snapshot;
}
