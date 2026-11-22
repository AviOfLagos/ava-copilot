// A screen recording for a task (docs/pm-desk.md, Part 7). The video itself is in `recordingChunks`, in a database
// of its own (./db.ts), so it never rides along in a backup.

export type RecordingStatus =
  // The panel is capturing
  | 'recording'
  // Stopped; every chunk is in, nothing saved yet
  | 'captured'
  // Going to Drive or Ava Brain
  | 'saving'
  // In Drive, on the Mac, or downloaded from the panel
  | 'saved'
  // Neither Drive nor Ava Brain: it waits for a download from the panel
  | 'waiting_download'
  // Saving failed and is not being retried; "Try again" starts it over
  | 'failed';

// What stopped it
export type RecordingEnd = 'stop' | 'call_ended' | 'silence' | 'limit' | 'panel_closed' | 'track_ended';

// What the browser's picker gave: a tab, a window or the whole screen
export type RecordingSurface = 'browser' | 'window' | 'monitor';

export type RecordingPlace =
  | { where: 'drive'; fileId: string; folder: string; webViewLink: string | null }
  | { where: 'brain'; path: string }
  | { where: 'download'; fileName: string; at: number };

export interface RecordingShare {
  state: 'private' | 'shared';
  // The "anyone with the link" permission, while shared
  permissionId: string | null;
  link: string | null;
  sharedAt: number | null;
  stoppedAt: number | null;
  // Counts each "Share": the do-once key of a share is per round, so sharing again after "Stop sharing" works
  round: number;
}

export interface RecordingRecord {
  // 'rec_' + 10 random base32 chars
  id: string;
  taskId: string;
  workspaceId: string | null;
  // The task's title when the recording started (the file is named after it)
  title: string;
  status: RecordingStatus;
  surface: RecordingSurface | null;
  withMic: boolean;
  withTabAudio: boolean;
  mimeType: string;
  startedAt: number;
  endedAt: number | null;
  endedBy: RecordingEnd | null;
  durationMs: number;
  // Every chunk written so far
  chunks: number;
  bytes: number;
  lastChunkAt: number | null;
  // "<date> <task title>.webm"
  fileName: string;
  saved: RecordingPlace | null;
  // Drive's resumable upload session. The address lets anyone holding it upload to that one file, so it is kept
  // here only (this database is never backed up or logged) and dropped once the file is in Drive.
  upload: { sessionUrl: string; bytes: number; startedAt: number } | null;
  share: RecordingShare;
  // A plain sentence for the panel when saving failed
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RecordingChunk {
  recordingId: string;
  // 0, 1, 2… in the order MediaRecorder gave them
  index: number;
  data: Blob;
  bytes: number;
  at: number;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 'rec_' + 10 random base32 chars. */
export function newRecordingId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `rec_${[...bytes].map(byte => BASE32[byte % 32]).join('')}`;
}

export const RECORDING_ID_PATTERN = /^rec_[a-z2-7]{10}$/;

const pad = (value: number) => String(value).padStart(2, '0');

/** A local date, YYYY-MM-DD. */
export function localDate(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * "<date> <task title>.webm", safe as a file name on a Mac, in Windows and in Drive: no slashes, colons or other
 * characters a file system refuses, no leading dots, at most 80 characters of title.
 */
export function recordingFileName(title: string, startedAt: number): string {
  const clean =
    title
      // eslint-disable-next-line no-control-regex -- control characters are what it removes
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+/, '')
      .trim()
      .slice(0, 80)
      .trim() || 'Recording';
  return `${localDate(startedAt)} ${clean}.webm`;
}

/** A folder name (a workspace's) with the same rules. */
export function safeFolderName(name: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex -- control characters are what it removes
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+/, '')
      .trim()
      .slice(0, 80)
      .trim() || 'No workspace'
  );
}
