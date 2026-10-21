import 'fake-indexeddb/auto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Dexie } from 'dexie';

vi.hoisted(async () => {
  const { installChrome } = await import('./helpers');
  installChrome();
});

import { AviCopilotDb } from '@extension/storage';
import { encodeValue, gunzip } from '../codec';
import { restoreSnapshot } from '../restore';
import { ChangeTracker, DEBOUNCE_MS, MAX_DELAY_MS, MIN_INTERVAL_MS } from '../schedule';
import { BackupService, collectSecrets } from '../service';
import type { BackupClient } from '../service';
import {
  buildSnapshot,
  checkSnapshot,
  EXCLUDED_STORAGE_KEYS,
  EXCLUDED_TABLES,
  NEWER_SNAPSHOT_MESSAGE,
  parseSnapshot,
} from '../snapshot';
import { DEFAULT_BACKUP_STATUS } from '../state';
import type { BackupStatus } from '../state';
import { fillEveryTable, memoryArea, memoryVault } from './helpers';

const freshDb = () => new AviCopilotDb(`backup-${crypto.randomUUID()}`);
const SRC = resolve(__dirname, '../../..');

async function snapshotOf(db: Dexie, area = memoryArea()) {
  const built = await buildSnapshot({ db, storage: area, extensionVersion: '0.2.0', now: () => 1_760_000_000_000 });
  return { built, snapshot: await parseSnapshot(built.bytes) };
}

async function dump(db: Dexie) {
  const out: Record<string, unknown> = {};
  for (const table of db.tables) out[table.name] = await encodeValue(await table.toArray());
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('what a snapshot covers', () => {
  it('has every table of the database but the excluded ones, found by listing them', async () => {
    const db = freshDb();
    await fillEveryTable(db);
    const { snapshot } = await snapshotOf(db);
    const all = db.tables.map(table => table.name);
    // The deny-list names real tables only: a renamed table cannot slip out of it silently
    for (const name of Object.keys(EXCLUDED_TABLES)) expect(all).toContain(name);
    const covered = all.filter(name => !Object.hasOwn(EXCLUDED_TABLES, name));
    expect(Object.keys(snapshot.db.tables).sort()).toEqual(covered.sort());
    for (const name of covered) expect(snapshot.db.tables[name]).toHaveLength(2);
    expect(snapshot.db.version).toBe(db.verno);
    expect(Object.keys(snapshot.db.schema).sort()).toEqual(covered.sort());
  });

  it('has every storage key the code writes, but the denied ones, including keys nobody listed', async () => {
    // Every key a store is created with in the source, as a string literal
    const keys = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/createStorage(?:<[^(]*>)?\(\s*'([^']+)'/g)) keys.add(match[1]);
    }
    expect(keys.size).toBeGreaterThan(30);
    // The deny-list names keys that exist in the source
    const everything = sourceFiles(SRC)
      .map(file => readFileSync(file, 'utf8'))
      .join('\n');
    for (const key of Object.keys(EXCLUDED_STORAGE_KEYS)) expect(everything).toContain(`'${key}'`);

    const area = memoryArea(
      Object.fromEntries([...keys, ...Object.keys(EXCLUDED_STORAGE_KEYS), 'a-store-added-later'].map(k => [k, { k }])),
    );
    const { snapshot } = await snapshotOf(freshDb(), area);
    for (const key of [...keys, 'a-store-added-later']) {
      if (Object.hasOwn(EXCLUDED_STORAGE_KEYS, key)) expect(snapshot.storage).not.toHaveProperty(key);
      else expect(snapshot.storage[key]).toEqual({ k: key });
    }
    for (const key of Object.keys(EXCLUDED_STORAGE_KEYS)) expect(snapshot.storage).not.toHaveProperty(key);
  });
});

describe('restore', () => {
  it('gives back identical data after a wipe (database, Blobs, storage), keeping this install’s own keys', async () => {
    const db = freshDb();
    await fillEveryTable(db);
    const area = memoryArea({
      'general-settings': { assistantName: 'Ava' },
      'llm-api-keys': { providers: { openai: { hasKey: true, keyRef: 'llm:openai' } } },
      onboarding: { completedAt: 5 },
      'brain-settings': { paired: true },
    });
    const before = await dump(db);
    const { snapshot } = await snapshotOf(db, area);

    // The reinstall: an empty database, and only this install's pairing in storage
    const wiped = freshDb();
    const fresh = memoryArea({ 'brain-settings': { paired: true, companionId: 'new' }, 'stale-key': 1 });
    const summary = await restoreSnapshot(snapshot, {
      db: wiped,
      makeDb: name => new AviCopilotDb(name),
      storage: fresh,
    });
    const after = await dump(wiped);
    for (const name of Object.keys(before)) {
      if (Object.hasOwn(EXCLUDED_TABLES, name)) continue;
      expect(after[name], name).toEqual(before[name]);
    }
    const blob = ((await wiped.messages.toArray())[0].attachments ?? [])[0].thumb;
    expect(blob).toBeInstanceOf(Blob);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 1]);
    expect(fresh.map.get('general-settings')).toEqual({ assistantName: 'Ava' });
    expect(fresh.map.has('stale-key')).toBe(false);
    expect(fresh.map.get('brain-settings')).toEqual({ paired: true, companionId: 'new' });
    expect(summary.migratedFrom).toBeNull();
    expect(summary.modelsRestored).toBe(true);
  });

  it('is a full replace: rows that are not in the snapshot are gone, jobs lose their old claims', async () => {
    const source = freshDb();
    await source.threads.put({ id: 'kept' } as never);
    await source.jobs.put({ id: 'j1', key: 'k', kind: 'x', status: 'running', leaseUntil: 9e12, runAt: 1 } as never);
    const { snapshot } = await snapshotOf(source);
    const target = freshDb();
    await target.threads.put({ id: 'local-only' } as never);
    await target.logs.put({ id: 'log-1', at: 1, level: 'info' } as never);
    await restoreSnapshot(snapshot, { db: target, makeDb: name => new AviCopilotDb(name), storage: memoryArea() });
    expect((await target.threads.toArray()).map(thread => thread.id)).toEqual(['kept']);
    expect(await target.jobs.get('j1')).toMatchObject({ status: 'scheduled', leaseUntil: null });
    // Excluded tables kept as they were on this browser
    expect(await target.logs.count()).toBe(1);
  });

  it('marks the first-run setup done when models came back', async () => {
    const area = memoryArea({ 'llm-api-keys': { providers: { openai: {} } } });
    const { snapshot } = await snapshotOf(freshDb(), area);
    const fresh = memoryArea();
    await restoreSnapshot(snapshot, { db: freshDb(), makeDb: n => new AviCopilotDb(n), storage: fresh, now: () => 42 });
    expect(fresh.map.get('onboarding')).toEqual({ completedAt: 42 });
  });

  it('migrates a snapshot from an older database version through the real upgrades', async () => {
    // The database as it was at version 3
    class OldDb extends Dexie {
      constructor(name: string) {
        super(name);
        this.version(1).stores({
          threads: 'id, updatedAt, status',
          messages: 'id, threadId, [threadId+seq]',
          meetings: 'id, threadId, startedAt',
          segments: 'id, meetingId, [meetingId+tStart]',
          kbItems: 'id, sourceType, sourceId, updatedAt',
          kbChunks: 'id, itemId',
        });
        this.version(2).stores({
          meetings: 'id, threadId, startedAt, status',
          audioChunks: 'id, meetingId, [meetingId+index], status',
        });
        this.version(3).stores({
          kbItems: 'id, sourceType, [sourceType+sourceId], updatedAt, sourceDate',
          kbChunks: 'id, itemId',
        });
      }
    }
    const old = new OldDb(`old-${crypto.randomUUID()}`);
    await old.table('threads').bulkPut([{ id: 't1', title: 'Old chat', updatedAt: 1, status: 'idle' }]);
    await old.table('kbItems').bulkPut([{ id: 'thread:t1', sourceType: 'thread', sourceId: 't1', updatedAt: 1 }]);
    const { snapshot } = await snapshotOf(old as unknown as Dexie);
    expect(snapshot.db.version).toBe(3);

    // Today's database, plus a version with an upgrade, to prove the upgrades run on the snapshot
    class NextDb extends AviCopilotDb {
      constructor(name: string) {
        super(name);
        this.version(6)
          .stores({})
          .upgrade(tx =>
            tx
              .table('threads')
              .toCollection()
              .modify(thread => {
                thread.title = `${thread.title} (migrated)`;
              }),
          );
      }
    }
    const target = new NextDb(`next-${crypto.randomUUID()}`);
    const summary = await restoreSnapshot(snapshot, { db: target, makeDb: n => new NextDb(n), storage: memoryArea() });
    expect(summary.migratedFrom).toBe(3);
    expect((await target.threads.get('t1'))?.title).toBe('Old chat (migrated)');
    // Indexed by the newer schema
    expect(await target.kbItems.where('[sourceType+sourceId]').equals(['thread', 't1']).count()).toBe(1);
    expect(await target.agents.count()).toBe(0);
  });

  it('refuses a snapshot from a newer version, with a clear message', async () => {
    const { snapshot } = await snapshotOf(freshDb());
    await expect(
      restoreSnapshot(
        { ...snapshot, db: { ...snapshot.db, version: 99 } },
        { db: freshDb(), makeDb: n => new AviCopilotDb(n), storage: memoryArea() },
      ),
    ).rejects.toThrow(NEWER_SNAPSHOT_MESSAGE);
    expect(() => checkSnapshot({ ...snapshot, formatVersion: 2 })).toThrow(NEWER_SNAPSHOT_MESSAGE);
  });
});

describe('reading a snapshot file', () => {
  it('refuses junk, bad table names and files that unpack too far', async () => {
    const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)) as Uint8Array<ArrayBuffer>;
    await expect(parseSnapshot(text({ hello: 1 }))).rejects.toThrow(/not a Nex Copilot backup/);
    await expect(parseSnapshot(new TextEncoder().encode('{nope') as Uint8Array<ArrayBuffer>)).rejects.toThrow();
    const { snapshot } = await snapshotOf(freshDb());
    const bad = { ...snapshot, db: { ...snapshot.db, tables: { 'drop table': [] } } };
    await expect(parseSnapshot(text(bad))).rejects.toThrow(/damaged/);
    // A gzip bomb stops at the limit
    const zeros = new Blob([new Uint8Array(4 * 1024 * 1024)]).stream().pipeThrough(new CompressionStream('gzip'));
    const bomb = new Uint8Array(await new Response(zeros).arrayBuffer());
    await expect(gunzip(bomb, 1024 * 1024)).rejects.toThrow(/unpacks to more/);
  });
});

describe('backups to Nex Brain', () => {
  function fakeBrain() {
    const stored: { meta: Record<string, unknown>; parts: string[] }[] = [];
    let secrets: Record<string, string> = {};
    const calls: string[] = [];
    const client = {
      async backupBegin(request: Record<string, unknown>) {
        calls.push('begin');
        stored.push({ meta: request, parts: [] });
        return { ok: true, uploadId: 'u'.repeat(32), chunkBytes: 64 };
      },
      async backupChunk(_id: string, _index: number, data: string) {
        stored[stored.length - 1].parts.push(data);
        return { ok: true };
      },
      async backupCommit() {
        calls.push('commit');
        const last = stored[stored.length - 1];
        return { ok: true, snapshot: { ...last.meta, id: '1760000000000-abcdef12' } };
      },
      async backupList() {
        const last = stored[stored.length - 1];
        return {
          ok: true,
          snapshots: last ? [{ ...last.meta, id: '1760000000000-abcdef12' }] : [],
          secrets: { storedAt: null, count: Object.keys(secrets).length },
        };
      },
      async backupRead(_id: string, index: number) {
        const last = stored[stored.length - 1];
        return { ok: true, index, chunks: last.parts.length, data: last.parts[index] };
      },
      async backupSecretsPut(_requestId: string, next: Record<string, string>) {
        calls.push('secretsPut');
        secrets = { ...next };
        return { ok: true, storedAt: 1, count: Object.keys(next).length };
      },
      async backupSecretsGet() {
        return { ok: true, secrets, storedAt: 1 };
      },
      async backupSecretsClear() {
        calls.push('secretsClear');
        secrets = {};
        return { ok: true };
      },
    };
    return { client: client as unknown as BackupClient, stored, calls, secrets: () => secrets };
  }

  function service(options: {
    db: AviCopilotDb;
    area: ReturnType<typeof memoryArea>;
    vault: ReturnType<typeof memoryVault>;
    includeSecrets?: boolean;
    paired?: boolean;
    brain: ReturnType<typeof fakeBrain>;
  }) {
    let status: BackupStatus = { ...DEFAULT_BACKUP_STATUS };
    return {
      service: new BackupService({
        client: options.brain.client,
        source: { db: options.db, storage: options.area, extensionVersion: '0.2.0' },
        target: { db: options.db, makeDb: n => new AviCopilotDb(n), storage: options.area, secrets: options.vault },
        vault: options.vault,
        paired: async () => options.paired ?? true,
        settings: async () => ({ includeSecrets: options.includeSecrets ?? true }),
        status: {
          get: async () => status,
          update: async changes => {
            status = { ...status, ...changes };
          },
        },
      }),
      status: () => status,
    };
  }

  const SECRET = 'sk-THIS-IS-THE-SECRET-VALUE-123456';

  it('sends the snapshot in parts and the keys to the Keychain side, never inside the snapshot', async () => {
    const db = freshDb();
    await fillEveryTable(db);
    const area = memoryArea({ 'llm-api-keys': { providers: { openai: { keyRef: 'llm:openai' } } } });
    const vault = memoryVault({ 'llm:openai': SECRET, 'companion:token': 'PAIRING-TOKEN', 'conn:c1:token': 'tok' });
    const brain = fakeBrain();
    const { service: backups, status } = service({ db, area, vault, brain });
    const meta = await backups.backupNow(true);
    expect(meta?.id).toBe('1760000000000-abcdef12');
    expect(brain.stored[0].parts.length).toBeGreaterThan(1);
    const bytes = Uint8Array.from(Buffer.concat(brain.stored[0].parts.map(part => Buffer.from(part, 'base64'))));
    const json = new TextDecoder().decode(await gunzip(bytes, 1e9));
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('PAIRING-TOKEN');
    expect(brain.secrets()).toEqual({ 'llm:openai': SECRET, 'conn:c1:token': 'tok' });
    expect(status().lastError).toBeNull();
    expect(status().lastSecrets).toBe(2);
  });

  it('keeps the keys off the Mac when the setting is off, and removes a copy already there', async () => {
    const brain = fakeBrain();
    const vault = memoryVault({ 'llm:openai': SECRET });
    const { service: backups } = service({ db: freshDb(), area: memoryArea(), vault, brain, includeSecrets: false });
    await backups.backupNow(true);
    expect(brain.calls).toContain('secretsClear');
    expect(brain.calls).not.toContain('secretsPut');
    expect(brain.secrets()).toEqual({});
  });

  it('skips silently when not paired, but says so when asked by hand', async () => {
    const brain = fakeBrain();
    const { service: backups } = service({
      db: freshDb(),
      area: memoryArea(),
      vault: memoryVault(),
      brain,
      paired: false,
    });
    expect(await backups.backupNow(false)).toBeNull();
    expect(brain.calls).toEqual([]);
    await expect(backups.backupNow(true)).rejects.toThrow(/Pair Nex Brain/);
  });

  it('restores from the Mac onto a fresh install, keys included, the pairing token untouched', async () => {
    const db = freshDb();
    await fillEveryTable(db);
    const brain = fakeBrain();
    const area = memoryArea({ 'general-settings': { assistantName: 'Ava' } });
    await service({ db, area, vault: memoryVault({ 'llm:openai': SECRET }), brain }).service.backupNow(true);

    const fresh = freshDb();
    const freshArea = memoryArea({ 'brain-settings': { paired: true } });
    const freshVault = memoryVault({ 'companion:token': 'NEW-PAIRING' });
    const { service: restorer } = service({ db: fresh, area: freshArea, vault: freshVault, brain });
    const summary = await restorer.restoreFromBrain('1760000000000-abcdef12');
    expect(summary.secrets).toBe(1);
    expect(freshVault.values.get('llm:openai')).toBe(SECRET);
    expect(freshVault.values.get('companion:token')).toBe('NEW-PAIRING');
    expect(freshArea.map.get('general-settings')).toEqual({ assistantName: 'Ava' });
    expect(await fresh.threads.count()).toBe(2);
  });

  it('collects every vault entry but the pairing token', async () => {
    const { secrets, skipped } = await collectSecrets(
      memoryVault({ 'companion:token': 'x', 'llm:a': 'k', 'bad name with spaces': 'v' }),
    );
    expect(secrets).toEqual({ 'llm:a': 'k' });
    expect(skipped).toBe(1);
  });
});

describe('when automatic backups run', () => {
  function tracker(start = 1_000_000) {
    let now = start;
    const planned: number[] = [];
    let paused = false;
    const t = new ChangeTracker({
      now: () => now,
      paused: () => paused,
      schedule: async runAt => {
        planned.push(runAt);
      },
    });
    return {
      t,
      planned,
      advance: (ms: number) => (now += ms),
      pause: (value: boolean) => (paused = value),
      now: () => now,
    };
  }

  it('waits 2 minutes after the last change, moving only when the time moves noticeably', () => {
    const { t, planned, advance, now } = tracker();
    t.touch();
    expect(planned).toEqual([now() + DEBOUNCE_MS]);
    advance(5_000);
    t.touch();
    // Moved by 5 s: not worth a write
    expect(planned).toHaveLength(1);
    advance(30_000);
    t.touch();
    expect(planned[1]).toBe(now() + DEBOUNCE_MS);
  });

  it('runs at most 10 minutes after the first change, and not sooner than 10 minutes after the last backup', () => {
    const { t, planned, advance, now } = tracker();
    const first = 1_000_000;
    for (let i = 0; i < 40; i++) {
      t.touch();
      advance(30_000);
    }
    expect(Math.max(...planned)).toBe(first + MAX_DELAY_MS);
    t.ran(now());
    t.touch();
    expect(planned[planned.length - 1]).toBe(now() + MIN_INTERVAL_MS);
  });

  it('plans nothing while paused (a restore, not paired, setup not done)', () => {
    const { t, planned, pause } = tracker();
    pause(true);
    expect(t.touch()).toBeNull();
    expect(planned).toEqual([]);
  });
});
