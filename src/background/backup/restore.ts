import { Dexie } from 'dexie';
import type { Table } from 'dexie';
import { AppError } from '@extension/shared';
import { LLM_PROVIDERS_STORAGE_KEY } from '@extension/storage/lib/settings/llmProviders';
import type { ConnectorRecord } from '@extension/storage';
import { BRAIN_TOKEN_REF } from '../companion/state';
import { allSecretRefs } from '../integrations/credentials';
import { EXCLUDED_TABLES, isExcludedStorageKey, NEWER_SNAPSHOT_MESSAGE } from './snapshot';
import type { Snapshot, StorageAreaLike } from './snapshot';
import { FILE_KEEP_STORAGE_KEYS, FILE_KEEP_TABLES, unbindMovedConnectors, unbindMovedProviders } from './trust';

/**
 * Puts a snapshot back: a full replace, not a merge. The database is replaced inside one Dexie transaction
 * (it all lands, or nothing changes), then chrome.storage.local, then the API keys. A snapshot from an older
 * database version is first written into a scratch database at its own version and opened with today's
 * schema, so Dexie runs the real upgrades on it; one from a newer version is refused.
 *
 * The caller reloads the extension afterwards, so every store and the search index read the restored data.
 * Scheduled jobs are never restored: the table is cleared and each feature's recovery schedules its own again
 * from what it stores (routines, agents, snoozes…) when the extension starts.
 *
 * `untrusted` (a file from disk): this browser's security settings stay, and keys are unbound from any provider or
 * connector whose endpoint changed (./trust.ts).
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
  // A file restore: the providers and connectors whose key was unbound, to be entered again
  unbound: { providers: string[]; connectors: string[] };
}

type Rows = Record<string, Record<string, unknown>[]>;

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
  options: { untrusted?: boolean } = {},
): Promise<RestoreSummary> {
  const untrusted = Boolean(options.untrusted);
  const { db } = target;
  if (!db.isOpen()) await db.open();
  if (snapshot.db.version > db.verno) throw new AppError('invalid', NEWER_SNAPSHOT_MESSAGE, { retryable: false });

  restoring = true;
  try {
    const older = snapshot.db.version < db.verno;
    const rows = { ...(older ? await migrate(snapshot, target) : snapshot.db.tables) };

    let unboundConnectors: string[] = [];
    if (untrusted && rows.connectors && db.tables.some(table => table.name === 'connectors')) {
      const current = (await db.table('connectors').toArray()) as ConnectorRecord[];
      const checked = unbindMovedConnectors(rows.connectors, current);
      rows.connectors = checked.rows;
      unboundConnectors = checked.unbound;
    }

    // The database: every table but the excluded ones is cleared and filled from the snapshot, in one transaction
    const replaced = db.tables.filter(
      table => EXCLUDED_TABLES[table.name]?.onRestore !== 'keep' && !(untrusted && FILE_KEEP_TABLES.has(table.name)),
    );
    const counts: Record<string, number> = {};
    await db.transaction('rw', replaced, async () => {
      for (const table of replaced as Table[]) {
        await table.clear();
        if (Object.hasOwn(EXCLUDED_TABLES, table.name)) continue;
        let kept = rows[table.name] ?? [];
        // Tool approvals a moved or new connector had are not carried to its new server
        if (table.name === 'toolFingerprints' && unboundConnectors.length) {
          kept = kept.filter(
            pin => !unboundConnectors.includes(String((pin as { connectorId?: unknown }).connectorId)),
          );
        }
        if (kept.length) await table.bulkPut(kept);
        counts[table.name] = kept.length;
      }
    });

    if (untrusted && unboundConnectors.length && db.tables.some(table => table.name === 'toolFingerprints')) {
      await db.table('toolFingerprints').where('connectorId').anyOf(unboundConnectors).delete();
    }

    // chrome.storage.local: the user's keys replaced, this install's own (pairing, caches) left as they are
    // (and, from a file, this browser's security settings)
    const keepHere = (key: string) => isExcludedStorageKey(key) || (untrusted && FILE_KEEP_STORAGE_KEYS.has(key));
    const current = await target.storage.get(null);
    const stale = Object.keys(current).filter(key => !keepHere(key));
    if (stale.length) await target.storage.remove(stale);
    const next = Object.fromEntries(Object.entries(snapshot.storage).filter(([key]) => !keepHere(key)));
    let unboundProviders: string[] = [];
    if (untrusted && next[LLM_PROVIDERS_STORAGE_KEY]) {
      const checked = unbindMovedProviders(next[LLM_PROVIDERS_STORAGE_KEY], current[LLM_PROVIDERS_STORAGE_KEY]);
      next[LLM_PROVIDERS_STORAGE_KEY] = checked.value;
      unboundProviders = checked.unbound;
    }
    const providers = (next[LLM_PROVIDERS_STORAGE_KEY] as { providers?: Record<string, unknown> } | undefined)
      ?.providers;
    const modelsRestored = Boolean(providers && Object.keys(providers).length);
    // Models came back: the first-run setup has nothing left to ask
    const onboarding = next[ONBOARDING_KEY] as { completedAt?: number } | undefined;
    if (modelsRestored && !onboarding?.completedAt) {
      next[ONBOARDING_KEY] = { completedAt: (target.now ?? Date.now)() };
    }
    await target.storage.set(next);

    // A connector that now points elsewhere loses the sign-in this browser had for that id
    if (target.secrets) {
      for (const id of unboundConnectors) {
        for (const ref of allSecretRefs(id)) await target.secrets.delete(ref).catch(() => {});
      }
    }

    // API keys: replaced only when the backup kept them (never from a file)
    let restored = 0;
    let failed = 0;
    if (secrets && target.secrets && !untrusted) {
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
      unbound: { providers: unboundProviders, connectors: unboundConnectors },
    };
  } finally {
    restoring = false;
  }
}
