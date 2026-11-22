import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupPath, RECORDING_ROUTES } from '@protocol';
import { startTestBrain, tempDir } from './helpers';

const RECORDING = 'rec_abcdefghij';

describe('recording routes', () => {
  let test: Awaited<ReturnType<typeof startTestBrain>>;
  let home: ReturnType<typeof tempDir>;
  afterEach(async () => {
    await test?.stop();
    home?.remove?.();
  });

  async function save(bytes: Buffer, request: Partial<{ recordingId: string; fileName: string; folder: string }> = {}) {
    const begin = await test.api(RECORDING_ROUTES.begin, {
      method: 'POST',
      body: JSON.stringify({
        requestId: `req-${Math.random()}`,
        recordingId: RECORDING,
        folder: 'Nexprove',
        fileName: '2026-11-22 Fix the login page.webm',
        bytes: bytes.length,
        ...request,
      }),
    });
    expect(begin.status).toBe(200);
    const reply = (await begin.json()) as { uploadId?: string; chunkBytes?: number; path?: string };
    if (reply.path) return reply.path;
    for (let index = 0; index * reply.chunkBytes! < bytes.length; index++) {
      const part = bytes.subarray(index * reply.chunkBytes!, (index + 1) * reply.chunkBytes!);
      const response = await test.api(backupPath(RECORDING_ROUTES.chunk, { uploadId: reply.uploadId!, index }), {
        method: 'PUT',
        body: JSON.stringify({ data: part.toString('base64') }),
      });
      expect(response.status).toBe(200);
    }
    const commit = await test.api(backupPath(RECORDING_ROUTES.commit, { uploadId: reply.uploadId! }), {
      method: 'POST',
    });
    expect(commit.status).toBe(200);
    return ((await commit.json()) as { path: string }).path;
  }

  it('saves to ~/Movies/Ava recordings/<workspace>/<file>, privately, and only for the paired extension', async () => {
    home = tempDir();
    test = await startTestBrain({ home: home.path });
    expect((await test.api(RECORDING_ROUTES.begin, { token: null })).status).toBe(401);
    await test.pair();
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 3, 9);
    const path = await save(bytes);
    expect(path).toBe(join(home.path, 'Movies', 'Ava recordings', 'Nexprove', '2026-11-22 Fix the login page.webm'));
    expect(Buffer.compare(readFileSync(path), bytes)).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // No part file is left behind
    expect(readdirSync(join(home.path, 'Movies', 'Ava recordings', 'Nexprove'))).toEqual([
      '2026-11-22 Fix the login page.webm',
    ]);
  });

  it('answers a recording it already saved with its path: a retried save makes no second file', async () => {
    home = tempDir();
    test = await startTestBrain({ home: home.path });
    await test.pair();
    const first = await save(Buffer.from('first'));
    const again = await save(Buffer.from('first'));
    expect(again).toBe(first);
    // Another recording with the same name gets its own file
    const other = await save(Buffer.from('other'), { recordingId: 'rec_bbbbbbbbbb' });
    expect(other).toMatch(/Fix the login page \(2\)\.webm$/);
    expect(existsSync(first) && existsSync(other)).toBe(true);
  });

  it('refuses names that would leave the folder', async () => {
    home = tempDir();
    test = await startTestBrain({ home: home.path });
    await test.pair();
    for (const bad of [
      { folder: '../Library' },
      { fileName: '../x.webm' },
      { fileName: 'x.mov' },
      { folder: '.hidden' },
    ]) {
      const response = await test.api(RECORDING_ROUTES.begin, {
        method: 'POST',
        body: JSON.stringify({
          requestId: `req-${Math.random()}`,
          recordingId: RECORDING,
          folder: 'Nexprove',
          fileName: 'a.webm',
          bytes: 10,
          ...bad,
        }),
      });
      expect(response.status).toBe(400);
    }
    expect(existsSync(join(home.path, 'Library'))).toBe(false);
  });
});
