import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { backupUploadIdSchema, RECORDING_CHUNK_BYTES, RECORDING_MAX_BYTES } from '@protocol';
import type { RecordingBeginRequest } from '@protocol';
import { fail } from '../errors';
import type { Logger } from '../log';

/**
 * Screen recordings saved on this Mac (docs/pm-desk.md, Part 7), for when Google Drive is not connected:
 * "~/Movies/Ava recordings/<workspace>/<date> <task title>.webm".
 *
 * An upload is written to a hidden ".<id>.part" file next to where it goes, chunk by chunk in order, and only takes
 * its name on commit, when its size checks out. A name already taken gets " (2)", " (3)"… Every recording saved is
 * noted in `recordings.json` under the data dir, so the same recording sent again (a save retried after its answer
 * was lost) answers with the path it already has instead of making a second file.
 */

const UPLOAD_TTL_MS = 60 * 60_000;
const MAX_UPLOADS = 2;

interface Upload {
  recordingId: string;
  dir: string;
  fileName: string;
  bytes: number;
  part: string;
  next: number;
  written: number;
  startedAt: number;
}

export class RecordingFiles {
  readonly root: string;
  private readonly indexPath: string;
  private readonly uploads = new Map<string, Upload>();

  constructor(
    private readonly deps: { dataDir: string; home?: string; log: Logger; now?: () => number; maxBytes?: number },
  ) {
    this.root = join(deps.home ?? homedir(), 'Movies', 'Ava recordings');
    this.indexPath = join(deps.dataDir, 'recordings.json');
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private saved(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private dropStale(): void {
    const now = this.now();
    for (const [id, upload] of this.uploads) {
      if (now - upload.startedAt < UPLOAD_TTL_MS) continue;
      this.uploads.delete(id);
      void rm(upload.part, { force: true });
    }
  }

  begin(
    request: Omit<RecordingBeginRequest, 'requestId'>,
  ): { uploadId: string; chunkBytes: number } | { path: string } {
    this.dropStale();
    const already = this.saved()[request.recordingId];
    if (already && existsSync(already)) return { path: already };
    if (request.bytes > (this.deps.maxBytes ?? RECORDING_MAX_BYTES)) fail('invalid', 'This recording is too large.');
    // One upload per recording: a second begin replaces the first, which is dropped
    for (const [id, upload] of this.uploads) {
      if (upload.recordingId !== request.recordingId) continue;
      this.uploads.delete(id);
      void rm(upload.part, { force: true });
    }
    if (this.uploads.size >= MAX_UPLOADS) {
      fail('rate_limit', 'Another recording is still being saved.', { retryAfterMs: 30_000 });
    }
    const dir = join(this.root, request.folder);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const uploadId = randomBytes(16).toString('hex');
    this.uploads.set(uploadId, {
      recordingId: request.recordingId,
      dir,
      fileName: request.fileName,
      bytes: request.bytes,
      part: join(dir, `.${uploadId}.part`),
      next: 0,
      written: 0,
      startedAt: this.now(),
    });
    return { uploadId, chunkBytes: RECORDING_CHUNK_BYTES };
  }

  private upload(uploadId: string): Upload {
    if (!backupUploadIdSchema.safeParse(uploadId).success) fail('invalid', 'That is not an upload.');
    const upload = this.uploads.get(uploadId);
    if (!upload) fail('not_found', 'That upload is not open any more. Save the recording again.');
    return upload;
  }

  /** Appends chunk `index`; chunks come in order, and a repeat of the last one is accepted once more. */
  async chunk(uploadId: string, index: number, data: Buffer): Promise<void> {
    const upload = this.upload(uploadId);
    if (index === upload.next - 1) return;
    if (index !== upload.next) fail('invalid', `Expected part ${upload.next} of the recording, got ${index}.`);
    if (data.length === 0 || data.length > RECORDING_CHUNK_BYTES) fail('invalid', 'A part has the wrong size.');
    if (upload.written + data.length > upload.bytes) fail('invalid', 'The recording is larger than announced.');
    await appendFile(upload.part, data, { mode: 0o600 });
    upload.written += data.length;
    upload.next += 1;
  }

  /** Gives the finished file its name and returns where it is. */
  async commit(uploadId: string): Promise<string> {
    const upload = this.upload(uploadId);
    if (upload.written !== upload.bytes) fail('invalid', 'Part of the recording is missing. Save it again.');
    this.uploads.delete(uploadId);
    const dot = upload.fileName.lastIndexOf('.');
    const stem = upload.fileName.slice(0, dot);
    const extension = upload.fileName.slice(dot);
    let path = join(upload.dir, upload.fileName);
    for (let copy = 2; existsSync(path); copy++) path = join(upload.dir, `${stem} (${copy})${extension}`);
    await rename(upload.part, path);
    const saved = this.saved();
    saved[upload.recordingId] = path;
    await writeFile(this.indexPath, JSON.stringify(saved), { mode: 0o600 });
    this.deps.log.info('A recording was saved', { bytes: upload.bytes });
    return path;
  }
}
