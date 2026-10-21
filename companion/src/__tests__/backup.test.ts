import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_CHUNK_BODY_BYTES,
  BACKUP_CHUNK_BYTES,
  backupListReplySchema,
  backupPath,
  BACKUP_ROUTES,
} from '@protocol';
import { securityKeychain } from '../backup/secrets';
import { snapshotsToKeep } from '../backup/store';
import { fakeRunner, memoryKeychain, startTestBrain } from './helpers';

const DAY = 24 * 60 * 60_000;

function snapshotBytes(size = 1000): Buffer {
  return gzipSync(Buffer.from(JSON.stringify({ format: 'nex-copilot-backup', pad: 'x'.repeat(size) })));
}

function meta(bytes: Buffer, createdAt = 1_760_000_000_000) {
  return {
    requestId: `req-${createdAt}-${bytes.length}`,
    createdAt,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    dbVersion: 5,
    extensionVersion: '0.3.0',
    counts: { threads: 2, messages: 10 },
  };
}

describe('retention', () => {
  it('keeps the last 14 and the newest of each day for 30 days', () => {
    const now = 100 * DAY + 12 * 3600_000;
    // Three a day for 40 days
    const snapshots = Array.from({ length: 120 }, (_, i) => ({
      id: String(i),
      createdAt: now - Math.floor(i / 3) * DAY - (i % 3) * 60_000,
    }));
    const keep = snapshotsToKeep(snapshots, now);
    // 14 newest (days 0..4) + one per day for days 5..30
    const days = new Set([...keep].map(id => Math.floor(Number(id) / 3)));
    expect(keep.has('0')).toBe(true);
    expect(keep.has('13')).toBe(true);
    expect(days.has(30)).toBe(true);
    expect(days.has(31)).toBe(false);
    expect(keep.size).toBe(14 + (30 - 4));
  });
});

describe('backup routes', () => {
  let test: Awaited<ReturnType<typeof startTestBrain>>;
  afterEach(async () => test?.stop());

  async function upload(bytes: Buffer, createdAt?: number) {
    const begin = await test.api(BACKUP_ROUTES.begin, { method: 'POST', body: JSON.stringify(meta(bytes, createdAt)) });
    expect(begin.status).toBe(200);
    const { uploadId, chunkBytes } = (await begin.json()) as { uploadId: string; chunkBytes: number };
    for (let index = 0; index * chunkBytes < bytes.length; index++) {
      const part = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
      const response = await test.api(backupPath(BACKUP_ROUTES.chunk, { uploadId, index }), {
        method: 'PUT',
        body: JSON.stringify({ data: part.toString('base64') }),
      });
      expect(response.status).toBe(200);
    }
    return test.api(backupPath(BACKUP_ROUTES.commit, { uploadId }), { method: 'POST' });
  }

  it('refuses callers that are not the paired extension', async () => {
    test = await startTestBrain();
    await test.pair();
    expect((await test.api(BACKUP_ROUTES.list, { token: null })).status).toBe(401);
    expect((await test.api(BACKUP_ROUTES.list, { token: 'wrong' })).status).toBe(401);
    expect((await test.api(BACKUP_ROUTES.list, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await test.api(BACKUP_ROUTES.secretsGet, { token: null })).status).toBe(401);
  });

  it('keeps a chunked snapshot, lists it, and hands it back byte for byte, in private files', async () => {
    test = await startTestBrain();
    await test.pair();
    // Random bytes do not compress: more than two chunks
    const bytes = Buffer.concat([
      snapshotBytes(),
      Buffer.from(createHash('sha512').update('x').digest()),
      Buffer.alloc(0),
    ]);
    const big = Buffer.concat([bytes, Buffer.alloc(BACKUP_CHUNK_BYTES * 2 + 10, 7)]);
    const commit = await upload(big);
    expect(commit.status).toBe(200);
    const { snapshot } = (await commit.json()) as { snapshot: { id: string; bytes: number } };
    expect(snapshot.bytes).toBe(big.length);

    const list = backupListReplySchema.parse(await (await test.api(BACKUP_ROUTES.list)).json());
    expect(list.snapshots.map(s => s.id)).toEqual([snapshot.id]);
    expect(list.snapshots[0].counts.threads).toBe(2);

    const parts: Buffer[] = [];
    for (let index = 0, chunks = 1; index < chunks; index++) {
      const reply = (await (
        await test.api(backupPath(BACKUP_ROUTES.read, { id: snapshot.id }), {
          method: 'POST',
          body: JSON.stringify({ index }),
        })
      ).json()) as { chunks: number; data: string };
      chunks = reply.chunks;
      parts.push(Buffer.from(reply.data, 'base64'));
    }
    expect(parts.length).toBe(3);
    expect(Buffer.concat(parts).equals(big)).toBe(true);

    const dir = test.brain.backups.dir;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(dir).filter(name => name.includes('.'))) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }

    const removed = await test.api(backupPath(BACKUP_ROUTES.remove, { id: snapshot.id }), { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(backupListReplySchema.parse(await (await test.api(BACKUP_ROUTES.list)).json()).snapshots).toEqual([]);
  });

  it('refuses a damaged, oversized, out-of-order or non-gzip upload', async () => {
    test = await startTestBrain();
    await test.pair();
    const bytes = snapshotBytes();
    // Announced larger than the cap
    const huge = await test.api(BACKUP_ROUTES.begin, {
      method: 'POST',
      body: JSON.stringify({ ...meta(bytes), bytes: 300 * 1024 * 1024 }),
    });
    expect(huge.status).toBe(400);

    // Wrong hash
    const begin = await test.api(BACKUP_ROUTES.begin, {
      method: 'POST',
      body: JSON.stringify({ ...meta(bytes), requestId: 'req-damaged-1', sha256: 'a'.repeat(64) }),
    });
    const { uploadId } = (await begin.json()) as { uploadId: string };
    // Part 1 before part 0
    const early = await test.api(backupPath(BACKUP_ROUTES.chunk, { uploadId, index: 1 }), {
      method: 'PUT',
      body: JSON.stringify({ data: bytes.toString('base64') }),
    });
    expect(early.status).toBe(400);
    await test.api(backupPath(BACKUP_ROUTES.chunk, { uploadId, index: 0 }), {
      method: 'PUT',
      body: JSON.stringify({ data: bytes.toString('base64') }),
    });
    const damaged = await test.api(backupPath(BACKUP_ROUTES.commit, { uploadId }), { method: 'POST' });
    expect(damaged.status).toBe(400);

    // A part that decodes to more than one chunk
    const second = await test.api(BACKUP_ROUTES.begin, {
      method: 'POST',
      body: JSON.stringify({ ...meta(bytes), requestId: 'req-damaged-2' }),
    });
    const next = (await second.json()) as { uploadId: string };
    const oversized = await test.api(backupPath(BACKUP_ROUTES.chunk, { uploadId: next.uploadId, index: 0 }), {
      method: 'PUT',
      body: JSON.stringify({ data: 'A'.repeat(Math.floor((BACKUP_CHUNK_BODY_BYTES - 8) / 4) * 4) }),
    });
    expect(oversized.status).toBe(400);

    // Not gzip
    const plain = Buffer.from('{"not":"gzip"}');
    expect((await upload(plain, 1_760_000_000_001)).status).toBe(400);
    expect(backupListReplySchema.parse(await (await test.api(BACKUP_ROUTES.list)).json()).snapshots).toEqual([]);
  }, 20_000);

  it('prunes old snapshots when a new one is kept', async () => {
    test = await startTestBrain();
    await test.pair();
    const now = Date.now();
    for (let i = 0; i < 16; i++) expect((await upload(snapshotBytes(i), now - i * 60_000)).status).toBe(200);
    // All within one day: the newest 14 are kept
    const list = backupListReplySchema.parse(await (await test.api(BACKUP_ROUTES.list)).json());
    expect(list.snapshots).toHaveLength(14);
    expect(list.snapshots[0].createdAt).toBe(now);
  });

  it('keeps API keys encrypted under a Keychain key, apart from the snapshots', async () => {
    const keychain = memoryKeychain();
    test = await startTestBrain({ keychain });
    await test.pair();
    const secret = 'sk-live-THIS-IS-A-SECRET-1234567890';
    const put = await test.api(BACKUP_ROUTES.secretsPut, {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-secrets-1', secrets: { 'llm:openai': secret, 'conn:x:token': 'tok-1' } }),
    });
    expect(put.status).toBe(200);
    expect(keychain.values.get('backup-key')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const file = readFileSync(join(test.brain.backups.dir, 'secrets.enc'), 'utf8');
    expect(file).not.toContain(secret);
    expect(statSync(join(test.brain.backups.dir, 'secrets.enc')).mode & 0o777).toBe(0o600);
    // Never logged
    expect(test.log.lines.join('\n')).not.toContain(secret);

    const list = backupListReplySchema.parse(await (await test.api(BACKUP_ROUTES.list)).json());
    expect(list.secrets.count).toBe(2);
    const got = (await (await test.api(BACKUP_ROUTES.secretsGet)).json()) as { secrets: Record<string, string> };
    expect(got.secrets['llm:openai']).toBe(secret);

    // Without the Keychain key the file is unreadable
    keychain.values.clear();
    expect((await test.api(BACKUP_ROUTES.secretsGet)).status).toBe(503);

    expect((await test.api(BACKUP_ROUTES.secretsClear, { method: 'DELETE' })).status).toBe(200);
    const after = backupListReplySchema.parse(await (await test.api(BACKUP_ROUTES.list)).json());
    expect(after.secrets).toEqual({ storedAt: null, count: 0 });
  });
});

describe('securityKeychain', () => {
  it('passes the key on standard input, never on the command line', async () => {
    const key = 'A'.repeat(43);
    const run = fakeRunner(call => (call.args[0] === 'find-generic-password' ? { stdout: `${key}\n` } : {}));
    const keychain = securityKeychain({ run, isMac: true });
    await keychain.set('backup-key', key);
    expect(await keychain.get('backup-key')).toBe(key);
    for (const call of run.calls) expect(call.args.join(' ')).not.toContain(key);
    expect(run.calls[0].args).toEqual(['-i']);
    expect(run.calls[0].options.stdin).toContain(key);
    expect(run.calls[0].options.stdin).toContain('"Nex Brain backup"');
  });

  it('refuses a value that could break out of the quoted line', async () => {
    const keychain = securityKeychain({ run: fakeRunner(() => ({})), isMac: true });
    await expect(keychain.set('backup-key', 'x" ; delete-keychain')).rejects.toThrow();
  });
});
