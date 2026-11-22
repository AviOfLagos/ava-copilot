import { Dexie } from 'dexie';
import type { Table } from 'dexie';
import type { RecordingChunk, RecordingRecord } from './types';

/**
 * Screen recordings live in a database of their own, "ava-recordings", not in the main one:
 *
 * - Backups copy the main database table by table (src/background/backup/snapshot.ts). A video is large and is
 *   not memory: keeping it here leaves it out of every backup without a rule anyone has to remember.
 * - The panel writes the chunks itself while it records (a Blob cannot travel over a message), so the main
 *   database's rule, "the background is the only writer", is not bent.
 *
 * Who writes what: the panel writes `recordingChunks` while the record is `recording`, and nothing else. Every
 * change to `recordings` is the background's (src/background/recordings), through the panel's commands.
 */
export class RecordingsDb extends Dexie {
  recordings!: Table<RecordingRecord, string>;
  recordingChunks!: Table<RecordingChunk, [string, number]>;

  constructor(name = 'ava-recordings') {
    super(name);
    this.version(1).stores({
      recordings: 'id, taskId, status, updatedAt',
      recordingChunks: '[recordingId+index], recordingId',
    });
  }
}

export const RECORDINGS_DB_NAME = 'ava-recordings';

export const recordingsDb = new RecordingsDb(RECORDINGS_DB_NAME);
