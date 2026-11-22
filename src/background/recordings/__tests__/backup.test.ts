import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(async () => {
  const { installChrome } = await import('../../backup/__tests__/helpers');
  installChrome();
});

import { AviCopilotDb, createRecordingStore, createTaskStore, RecordingsDb } from '@extension/storage';
import { memoryArea } from '../../backup/__tests__/helpers';
import { gunzip } from '../../backup/codec';
import { buildSnapshot } from '../../backup/snapshot';

const MARKER = 'VIDEO-BYTES-THAT-MUST-NOT-BE-IN-A-BACKUP';

describe('a backup made after a recording', () => {
  it('does not contain the recording', async () => {
    const db = new AviCopilotDb(`main-${crypto.randomUUID()}`);
    const task = await createTaskStore(db).add({ title: 'Fix the login page', workspaceId: null });
    const recordings = createRecordingStore(new RecordingsDb(`rec-${crypto.randomUUID()}`));
    const record = await recordings.create({
      taskId: task.id,
      workspaceId: null,
      title: task.title,
      surface: 'browser',
      withMic: true,
      withTabAudio: true,
      mimeType: 'video/webm',
    });
    await recordings.addChunk(record.id, 0, new Blob([MARKER]));

    const built = await buildSnapshot({
      db,
      storage: memoryArea({ 'recording-settings': { maxMinutes: 10, driveNudged: false } }),
      extensionVersion: '0.2.0',
    });
    const text = new TextDecoder().decode(await gunzip(built.bytes, 100 * 1024 * 1024));
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain('recordingChunks');
    expect(text).not.toContain(record.id);
    // The task itself is in it
    expect(text).toContain(task.id);
  });

  it('is made from the main database only, which has no recording tables', () => {
    const register = readFileSync(resolve(__dirname, '../../backup/register.ts'), 'utf8');
    expect(register).toMatch(/source: \{ db, storage: area/);
    const db = new AviCopilotDb(`main-${crypto.randomUUID()}`);
    expect(db.tables.map(table => table.name)).not.toContain('recordingChunks');
    expect(db.tables.map(table => table.name)).not.toContain('recordings');
  });
});
