import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createRecordingStore } from '../store';
import { RecordingsDb } from '../db';
import { recordingFileName, safeFolderName } from '../types';

const store = () => createRecordingStore(new RecordingsDb(`rec-${crypto.randomUUID()}`));
const input = {
  taskId: 'tsk_aaaaaaaaaa',
  workspaceId: null,
  title: 'Demo',
  surface: 'browser' as const,
  withMic: true,
  withTabAudio: false,
  mimeType: 'video/webm',
};

describe('recordings store', () => {
  it('keeps chunks in order and joins them into one WebM', async () => {
    const recordings = store();
    const record = await recordings.create(input);
    for (const [index, text] of ['a', 'b', 'c'].entries())
      await recordings.addChunk(record.id, index, new Blob([text]));
    const blob = await recordings.blob(record.id);
    expect(await blob!.text()).toBe('abc');
    expect(blob!.type).toBe('video/webm');
    expect((await recordings.get(record.id))!).toMatchObject({ chunks: 3, bytes: 3 });
  });

  it('refuses a chunk once the recording is no longer recording', async () => {
    const recordings = store();
    const record = await recordings.create(input);
    await recordings.update(record.id, { status: 'captured' });
    expect(await recordings.addChunk(record.id, 0, new Blob(['late']))).toBe(false);
    expect(await recordings.hasChunks(record.id)).toBe(false);
  });

  it('names files "<date> <task title>.webm", safe on a Mac and in Drive', () => {
    const at = new Date(2026, 10, 22, 9, 30).getTime();
    expect(recordingFileName('Fix: the/login page?', at)).toBe('2026-11-22 Fix the login page.webm');
    expect(recordingFileName('...', at)).toBe('2026-11-22 Recording.webm');
    expect(recordingFileName('x'.repeat(200), at)).toHaveLength('2026-11-22 '.length + 80 + '.webm'.length);
    expect(safeFolderName('../Acme')).toBe('Acme');
    expect(safeFolderName('')).toBe('No workspace');
  });
});
