import { Dexie } from 'dexie';
import { db as defaultDb } from '../threads/db';
import type { AudioChunk, AviCopilotDb, MeetingRecord, TranscriptSegment } from '../threads/db';

export function newMeeting(fields: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: crypto.randomUUID(),
    threadId: null,
    tabId: null,
    title: '',
    platform: '',
    url: '',
    startedAt: Date.now(),
    endedAt: null,
    status: 'recording',
    source: 'audio',
    withMic: false,
    rollingSummary: '',
    summaryAt: 0,
    summaryUpTo: 0,
    blockSummaries: [],
    note: null,
    markdown: '',
    warnings: [],
    liveCaptions: [],
    live: 'off',
    chunksTotal: 0,
    chunksDone: 0,
    error: null,
    ...fields,
  };
}

/**
 * Meetings, their queued audio and their transcripts, over a database that defaults to the extension's own.
 */
export function createMeetingStore(db: AviCopilotDb = defaultDb) {
  const store = {
    db,

    async create(fields: Partial<MeetingRecord> = {}): Promise<MeetingRecord> {
      const meeting = newMeeting(fields);
      await db.meetings.add(meeting);
      return meeting;
    },

    get: (id: string) => db.meetings.get(id),

    async update(id: string, changes: Partial<MeetingRecord>): Promise<void> {
      await db.meetings.update(id, changes);
    },

    /** Meetings that are recording or being finished. */
    active: () => db.meetings.where('status').anyOf('recording', 'finishing').toArray(),

    /** Newest first. */
    list: () => db.meetings.orderBy('startedAt').reverse().toArray(),

    /** Adds a live caption, keeping the most recent ones. */
    async addLiveCaption(id: string, caption: { t: number; text: string }, keep = 60): Promise<void> {
      await db.meetings
        .where('id')
        .equals(id)
        .modify(meeting => {
          meeting.liveCaptions = [...(meeting.liveCaptions ?? []), caption].slice(-keep);
        });
    },

    async addWarning(id: string, warning: MeetingRecord['warnings'][number]): Promise<void> {
      await db.meetings
        .where('id')
        .equals(id)
        .modify(meeting => {
          if (!meeting.warnings.includes(warning)) meeting.warnings.push(warning);
        });
    },

    async clearWarning(id: string, warning: MeetingRecord['warnings'][number]): Promise<void> {
      await db.meetings
        .where('id')
        .equals(id)
        .modify(meeting => {
          meeting.warnings = meeting.warnings.filter(w => w !== warning);
        });
    },

    /** Queues a chunk of audio for transcription. */
    async addChunk(chunk: Omit<AudioChunk, 'status' | 'attempts' | 'createdAt'>): Promise<void> {
      await db.transaction('rw', db.audioChunks, db.meetings, async () => {
        await db.audioChunks.add({ ...chunk, status: 'pending', attempts: 0, createdAt: Date.now() });
        await db.meetings
          .where('id')
          .equals(chunk.meetingId)
          .modify(meeting => {
            meeting.chunksTotal = Math.max(meeting.chunksTotal, chunk.index + 1);
          });
      });
    },

    /** Chunks waiting for transcription, oldest first. */
    async pendingChunks(meetingId: string): Promise<AudioChunk[]> {
      return db.audioChunks
        .where('[meetingId+index]')
        .between([meetingId, Dexie.minKey], [meetingId, Dexie.maxKey])
        .filter(chunk => chunk.status === 'pending')
        .toArray();
    },

    async chunks(meetingId: string): Promise<AudioChunk[]> {
      return db.audioChunks
        .where('[meetingId+index]')
        .between([meetingId, Dexie.minKey], [meetingId, Dexie.maxKey])
        .toArray();
    },

    async updateChunk(id: string, changes: Partial<AudioChunk>): Promise<void> {
      await db.audioChunks.update(id, changes);
    },

    /** Stores the transcript of a chunk and marks the chunk done, together. */
    async completeChunk(
      chunk: AudioChunk,
      segments: Omit<TranscriptSegment, 'id'>[],
      keepAudio: boolean,
    ): Promise<void> {
      await db.transaction('rw', db.audioChunks, db.segments, db.meetings, async () => {
        await db.segments.bulkAdd(segments.map(segment => ({ ...segment, id: crypto.randomUUID() })));
        await db.audioChunks.update(chunk.id, { status: 'done', ...(keepAudio ? {} : { data: null }) });
        await db.meetings
          .where('id')
          .equals(chunk.meetingId)
          .modify(meeting => {
            meeting.chunksDone += 1;
          });
      });
    },

    async updateSegment(id: string, changes: Partial<TranscriptSegment>): Promise<void> {
      await db.segments.update(id, changes);
    },

    async deleteSegment(id: string): Promise<void> {
      await db.segments.delete(id);
    },

    async addSegments(segments: Omit<TranscriptSegment, 'id'>[]): Promise<void> {
      await db.segments.bulkAdd(segments.map(segment => ({ ...segment, id: crypto.randomUUID() })));
    },

    /** The transcript of a meeting in time order. */
    async segments(meetingId: string, fromSeconds = 0): Promise<TranscriptSegment[]> {
      return db.segments
        .where('[meetingId+tStart]')
        .between([meetingId, fromSeconds], [meetingId, Dexie.maxKey], true, true)
        .toArray();
    },

    /** Deletes a meeting with its audio and transcript. */
    async remove(id: string): Promise<void> {
      await db.transaction('rw', db.meetings, db.audioChunks, db.segments, async () => {
        await db.audioChunks.where('meetingId').equals(id).delete();
        await db.segments.where('meetingId').equals(id).delete();
        await db.meetings.delete(id);
      });
    },
  };
  return store;
}

export type MeetingStore = ReturnType<typeof createMeetingStore>;

export const meetingStore = createMeetingStore();
