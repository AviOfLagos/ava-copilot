import { recordingsDb } from './db';
import type { RecordingsDb } from './db';
import { newRecordingId, recordingFileName } from './types';
import type { RecordingChunk, RecordingRecord, RecordingSurface } from './types';

export interface NewRecording {
  taskId: string;
  workspaceId: string | null;
  title: string;
  surface: RecordingSurface | null;
  withMic: boolean;
  withTabAudio: boolean;
  mimeType: string;
}

/** The recordings and their chunks, over a database that defaults to the extension's own. Tests pass their own. */
export function createRecordingStore(db: RecordingsDb = recordingsDb, now: () => number = Date.now) {
  const store = {
    db,

    get(id: string): Promise<RecordingRecord | undefined> {
      return db.recordings.get(id);
    },

    /** A task's recordings, newest first. */
    async forTask(taskId: string): Promise<RecordingRecord[]> {
      return (await db.recordings.where('taskId').equals(taskId).toArray()).sort((a, b) => b.startedAt - a.startedAt);
    },

    async withStatus(status: RecordingRecord['status']): Promise<RecordingRecord[]> {
      return db.recordings.where('status').equals(status).toArray();
    },

    async create(input: NewRecording): Promise<RecordingRecord> {
      const at = now();
      const record: RecordingRecord = {
        id: newRecordingId(),
        ...input,
        title: input.title.slice(0, 200),
        status: 'recording',
        startedAt: at,
        endedAt: null,
        endedBy: null,
        durationMs: 0,
        chunks: 0,
        bytes: 0,
        lastChunkAt: null,
        fileName: recordingFileName(input.title, at),
        saved: null,
        upload: null,
        share: { state: 'private', permissionId: null, link: null, sharedAt: null, stoppedAt: null, round: 0 },
        error: null,
        createdAt: at,
        updatedAt: at,
      };
      await db.recordings.add(record);
      return record;
    },

    async update(id: string, changes: Partial<Omit<RecordingRecord, 'id'>>): Promise<RecordingRecord | undefined> {
      await db.recordings.update(id, { ...changes, updatedAt: now() });
      return db.recordings.get(id);
    },

    /**
     * Writes one chunk (the panel, while recording). Refused once the recording is no longer `recording`: a late
     * chunk after the background closed it would change a file that may already be on its way to Drive.
     */
    async addChunk(recordingId: string, index: number, data: Blob): Promise<boolean> {
      return db.transaction('rw', db.recordings, db.recordingChunks, async () => {
        const record = await db.recordings.get(recordingId);
        if (record?.status !== 'recording') return false;
        const at = now();
        await db.recordingChunks.put({ recordingId, index, data, bytes: data.size, at });
        await db.recordings.update(recordingId, {
          chunks: Math.max(record.chunks, index + 1),
          bytes: record.bytes + data.size,
          lastChunkAt: at,
          updatedAt: at,
        });
        return true;
      });
    },

    /** Every chunk of a recording, in order. */
    async chunks(recordingId: string): Promise<RecordingChunk[]> {
      return db.recordingChunks
        .where('[recordingId+index]')
        .between([recordingId, 0], [recordingId, Infinity])
        .toArray();
    },

    /** The whole video as one Blob (Blobs are kept on disk by the browser; this does not read them into memory). */
    async blob(recordingId: string, mimeType = 'video/webm'): Promise<Blob | null> {
      const chunks = await store.chunks(recordingId);
      if (chunks.length === 0) return null;
      return new Blob(
        chunks.map(chunk => chunk.data),
        { type: mimeType.split(';')[0] },
      );
    },

    async hasChunks(recordingId: string): Promise<boolean> {
      return (await db.recordingChunks.where('recordingId').equals(recordingId).count()) > 0;
    },

    async deleteChunks(recordingId: string): Promise<void> {
      await db.recordingChunks.where('recordingId').equals(recordingId).delete();
    },

    async remove(recordingId: string): Promise<void> {
      await db.transaction('rw', db.recordings, db.recordingChunks, async () => {
        await db.recordingChunks.where('recordingId').equals(recordingId).delete();
        await db.recordings.delete(recordingId);
      });
    },
  };
  return store;
}

export type RecordingStore = ReturnType<typeof createRecordingStore>;

export const recordingStore = createRecordingStore();
