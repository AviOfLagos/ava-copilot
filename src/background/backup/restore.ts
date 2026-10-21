import { Dexie } from 'dexie';
import type { Table } from 'dexie';
import { AppError } from '@extension/shared';
import { LLM_PROVIDERS_STORAGE_KEY } from '@extension/storage/lib/settings/llmProviders';
import { BRAIN_TOKEN_REF } from '../companion/state';
import { EXCLUDED_TABLES, isExcludedStorageKey, NEWER_SNAPSHOT_MESSAGE } from './snapshot';
import type { Snapshot, StorageAreaLike } from './snapshot';

/**
 * Puts a snapshot back: a full replace, not a merge. The database is replaced inside one Dexie transaction
 * (it all lands, or nothing changes), then chrome.storage.local, then the API keys. A snapshot from an older
 * database version is first written into a scratch database at its own version and opened with today's
 * schema, so Dexie runs the real upgrades on it; one from a newer version is refused.
 *
 * The caller reloads the extension afterwards, so every store and the search index read the restored data.
 */

// Vault entries a restore never touches: the pairing with Nex Brain belongs to this install
export const PROTECTED_SECRET_REFS = new Set([BRAIN_TOKEN_REF]);
const ONBOARDING_KEY = 'onboarding';

let restoring = false;
/** While a restore runs, its own writes are not changes to back up. */
export const isRestoring = (): boolean => restoring;

export interface SecretsTarget {
  refs(): Promise<string[]>;
  put(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export interface RestoreTarget {
  db: Dexie;
  // A database of the same class under another name, for migrating an older snapshot
  makeDb: (name: string) => Dexie;
  storage: StorageAreaLike;
  secrets?: SecretsTarget;
  now?: () => number;
}

export interface RestoreSummary {
  rows: Record<string, number>;
  storageKeys: number;
  secrets: number;
  secretsFailed: number;
  migratedFrom: number | null;
  modelsRestored: boolean;
}

type Rows = Record<string, Record<string, unknown>[]>;

/** What a restored row must not carry over: a job's claim from the old install. */
function sanitize(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (table !== 'jobs') return rows;
  return rows.map(job =>
    job.status === 'running' || job.leaseUntil
      ? { ...job, leaseUntil: null, status: job.status === 'running' ? 'scheduled' : job.status }
      : job,
  );
}

async function readAll(db: Dexie): Promise<Rows> {
  const rows: Rows = {};
  for (const table of db.tables) rows[table.name] = (await table.toArray()) as Record<string, unknown>[];
  return rows;
}

/** Writes the snapshot at its own version into a scratch database and opens it as today's, running the upgrades. */
async function migrate(snapshot: Snapshot, target: RestoreTarget): Promise<Rows> {
  const name = `${target.db.name}-restore`;
  await Dexie.delete(name);
  const old = new Dexie(name);
  old.version(snapshot.db.version).stores(snapshot.db.schema);
  try {
    await old.open();
    await old.transaction('rw', old.tables, async () => {
      for (const table of old.tables) {
        const rows = snapshot.db.tables[table.name];
        if (rows?.length) await table.bulkAdd(rows);
      }
    });
  } finally {
    old.close();
  }
  const current = target.makeDb(name);
  try {
    await current.open();
    return await readAll(current);
  } finally {
    current.close();
    await Dexie.delete(name);
  }
}

export async function restoreSnapshot(
  snapshot: Snapshot,
  target: RestoreTarget,
  secrets: Record<string, string> | null = null,
): Promise<RestoreSummary> {
  const { db } = target;
  if (!db.isOpen()) await db.open();
  if (snapshot.db.version > db.verno) throw new AppError('invalid', NEWER_SNAPSHOT_MESSAGE, { retryable: false });

  restoring = true;
  try {
    const older = snapshot.db.version < db.verno;
    const rows = older ? await migrate(snapshot, target) : snapshot.db.tables;

    // The database: every table but the excluded ones is cleared and filled from the snapshot, in one transaction
    const replaced = db.tables.filter(table => EXCLUDED_TABLES[table.name]?.onRestore !== 'keep');
    const counts: Record<string, number> = {};
    await db.transaction('rw', replaced, async () => {
      for (const table of replaced as Table[]) {
        await table.clear();
        if (Object.hasOwn(EXCLUDED_TABLES, table.name)) continue;
        const kept = sanitize(table.name, rows[table.name] ?? []);
        if (kept.length) await table.bulkPut(kept);
        counts[table.name] = kept.length;
      }
    });

    // chrome.storage.local: the user's keys replaced, this install's own (pairing, caches) left as they are
    const current = await target.storage.get(null);
    const stale = Object.keys(current).filter(key => !isExcludedStorageKey(key));
    if (stale.length) await target.storage.remove(stale);
    const next = Object.fromEntries(Object.entries(snapshot.storage).filter(([key]) => !isExcludedStorageKey(key)));
    const providers = (next[LLM_PROVIDERS_STORAGE_KEY] as { providers?: Record<string, unknown> } | undefined)
      ?.providers;
    const modelsRestored = Boolean(providers && Object.keys(providers).length);
    // Models came back: the first-run setup has nothing left to ask
    const onboarding = next[ONBOARDING_KEY] as { completedAt?: number } | undefined;
    if (modelsRestored && !onboarding?.completedAt) {
      next[ONBOARDING_KEY] = { completedAt: (target.now ?? Date.now)() };
    }
    await target.storage.set(next);

    // API keys: replaced only when the backup kept them
    let restored = 0;
    let failed = 0;
    if (secrets && target.secrets) {
      for (const ref of await target.secrets.refs()) {
        if (!PROTECTED_SECRET_REFS.has(ref) && !Object.hasOwn(secrets, ref)) await target.secrets.delete(ref);
      }
      for (const [ref, value] of Object.entries(secrets)) {
        if (PROTECTED_SECRET_REFS.has(ref)) continue;
        try {
          await target.secrets.put(ref, value);
          restored += 1;
        } catch {
          failed += 1;
        }
      }
    }

    return {
      rows: counts,
      storageKeys: Object.keys(next).length,
      secrets: restored,
      secretsFailed: failed,
      migratedFrom: older ? snapshot.db.version : null,
      modelsRestored,
    };
  } finally {
    restoring = false;
  }
}
