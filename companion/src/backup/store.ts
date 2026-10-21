import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { appendFile, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BACKUP_CHUNK_BYTES,
  BACKUP_KEEP_DAYS,
  BACKUP_KEEP_LAST,
  BACKUP_MAX_BYTES,
  backupIdSchema,
  backupMetaSchema,
  backupUploadIdSchema,
} from '@protocol';
import type { BackupBeginRequest, BackupMeta } from '@protocol';
import { fail } from '../errors';
import type { Logger } from '../log';

/**
 * Snapshots of the extension's memory and settings, kept on the Mac so they outlive an uninstall of the
 * extension. Nex Brain never reads inside one: it stores the gzipped bytes it was sent (checked against the
 * size and SHA-256 announced first) and hands them back in chunks. Files are 0600 in a 0700 folder.
 *
 * An upload is written to `uploads/<id>.part` in order, chunk by chunk, and only becomes a snapshot on commit,
 * when its size, hash and gzip header check out. Unfinished uploads are dropped after an hour.
 */

const UPLOAD_TTL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
// At most this many uploads open at once
const MAX_UPLOADS = 3;

interface Upload {
  meta: Omit<BackupMeta, 'id'>;
  path: string;
  next: number;
  written: number;
  hash: ReturnType<typeof createHash>;
  startedAt: number;
}

/** Which snapshots to keep: the newest `keepLast`, and the newest of each day of the last `keepDays`. */
export function snapshotsToKeep(
  snapshots: Pick<BackupMeta, 'id' | 'createdAt'>[],
  now: number,
  keepLast = BACKUP_KEEP_LAST,
  keepDays = BACKUP_KEEP_DAYS,
): Set<string> {
  const newest = [...snapshots].sort((a, b) => b.createdAt - a.createdAt);
  const keep = new Set(newest.slice(0, keepLast).map(snapshot => snapshot.id));
  const days = new Set<string>();
  for (const snapshot of newest) {
    if (now - snapshot.createdAt > keepDays * DAY_MS) continue;
    const day = new Date(snapshot.createdAt).toISOString().slice(0, 10);
    if (days.has(day)) continue;
    days.add(day);
    keep.add(snapshot.id);
  }
  return keep;
}

export class BackupStore {
  readonly dir: string;
  private readonly uploadDir: string;
  private readonly uploads = new Map<string, Upload>();

  constructor(private readonly deps: { dataDir: string; log: Logger; now?: () => number; maxBytes?: number }) {
    this.dir = join(deps.dataDir, 'backups');
    this.uploadDir = join(this.dir, 'uploads');
    for (const dir of [this.dir, this.uploadDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    // Uploads from a run that stopped cannot be finished
    for (const name of readdirSync(this.uploadDir)) rmSync(join(this.uploadDir, name), { force: true });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get maxBytes(): number {
    return this.deps.maxBytes ?? BACKUP_MAX_BYTES;
  }

  private dataPath(id: string): string {
    return join(this.dir, `${id}.json.gz`);
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.meta.json`);
  }

  /** The snapshots, newest first. A file that does not read as one is left out. */
  list(): BackupMeta[] {
    const snapshots: BackupMeta[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.meta.json')) continue;
      try {
        const meta = backupMetaSchema.parse(JSON.parse(readFileSync(join(this.dir, name), 'utf8')));
        if (existsSync(this.dataPath(meta.id))) snapshots.push(meta);
      } catch {
        this.deps.log.warn('A backup description did not read', { file: name });
      }
    }
    return snapshots.sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): BackupMeta {
    if (!backupIdSchema.safeParse(id).success) fail('invalid', 'That is not a backup.');
    const found = this.list().find(snapshot => snapshot.id === id);
    if (!found) fail('not_found', 'That backup is not on this Mac any more.');
    return found;
  }

  private dropStale(): void {
    const now = this.now();
    for (const [id, upload] of this.uploads) {
      if (now - upload.startedAt < UPLOAD_TTL_MS) continue;
      this.uploads.delete(id);
      rmSync(upload.path, { force: true });
    }
  }

  begin(meta: Omit<BackupBeginRequest, 'requestId'>): { uploadId: string; chunkBytes: number } {
    this.dropStale();
    if (meta.bytes > this.maxBytes) {
      fail('invalid', `This backup is larger than ${Math.round(this.maxBytes / 1024 / 1024)} MB.`);
    }
    if (this.uploads.size >= MAX_UPLOADS)
      fail('rate_limit', 'Another backup is still being sent.', { retryAfterMs: 60_000 });
    const uploadId = randomBytes(16).toString('hex');
    const path = join(this.uploadDir, `${uploadId}.part`);
    this.uploads.set(uploadId, {
      meta,
      path,
      next: 0,
      written: 0,
      hash: createHash('sha256'),
      startedAt: this.now(),
    });
    return { uploadId, chunkBytes: BACKUP_CHUNK_BYTES };
  }

  private upload(uploadId: string): Upload {
    if (!backupUploadIdSchema.safeParse(uploadId).success) fail('invalid', 'That is not an upload.');
    const upload = this.uploads.get(uploadId);
    if (!upload) fail('not_found', 'That upload is not open any more. Start the backup again.');
    return upload;
  }

  /** Appends chunk `index`; chunks come in order, and a repeat of the last one is accepted once more. */
  async chunk(uploadId: string, index: number, data: Buffer): Promise<void> {
    const upload = this.upload(uploadId);
    if (index === upload.next - 1) return;
    if (index !== upload.next) fail('invalid', `Expected part ${upload.next} of the backup, got ${index}.`);
    if (data.length === 0 || data.length > BACKUP_CHUNK_BYTES)
      fail('invalid', 'A part of the backup has the wrong size.');
    if (upload.written + data.length > upload.meta.bytes) fail('invalid', 'The backup is larger than announced.');
    await appendFile(upload.path, data, { mode: 0o600 });
    upload.hash.update(data);
    upload.written += data.length;
    upload.next += 1;
  }

  /** Checks the upload against what was announced and keeps it, then applies the retention. */
  async commit(uploadId: string): Promise<BackupMeta> {
    const upload = this.upload(uploadId);
    this.uploads.delete(uploadId);
    try {
      if (upload.written !== upload.meta.bytes) fail('invalid', 'The backup arrived incomplete. Try again.');
      if (upload.hash.digest('hex') !== upload.meta.sha256) fail('invalid', 'The backup arrived damaged. Try again.');
      const handle = await open(upload.path, 'r');
      const head = Buffer.alloc(2);
      await handle.read(head, 0, 2, 0);
      await handle.close();
      if (head[0] !== 0x1f || head[1] !== 0x8b) fail('invalid', 'A backup must be gzipped.');
      const id = `${String(upload.meta.createdAt).padStart(13, '0')}-${randomBytes(4).toString('hex')}`;
      const meta = backupMetaSchema.parse({ ...upload.meta, id });
      await rename(upload.path, this.dataPath(id));
      chmodSync(this.dataPath(id), 0o600);
      await writeFile(this.metaPath(id), JSON.stringify(meta), { mode: 0o600 });
      this.prune();
      this.deps.log.info('Backup kept', { id, bytes: meta.bytes });
      return meta;
    } finally {
      await rm(upload.path, { force: true });
    }
  }

  /** Chunk `index` of a snapshot, and how many there are. */
  async read(id: string, index: number): Promise<{ data: Buffer; chunks: number }> {
    const meta = this.get(id);
    const chunks = Math.max(1, Math.ceil(meta.bytes / BACKUP_CHUNK_BYTES));
    if (index >= chunks) fail('invalid', 'That part of the backup does not exist.');
    const handle = await open(this.dataPath(id), 'r');
    try {
      const size = Math.min(BACKUP_CHUNK_BYTES, meta.bytes - index * BACKUP_CHUNK_BYTES);
      const data = Buffer.alloc(size);
      await handle.read(data, 0, size, index * BACKUP_CHUNK_BYTES);
      return { data, chunks };
    } finally {
      await handle.close();
    }
  }

  remove(id: string): void {
    this.get(id);
    rmSync(this.metaPath(id), { force: true });
    rmSync(this.dataPath(id), { force: true });
  }

  /** Deletes what the retention does not keep. */
  prune(): void {
    const all = this.list();
    const keep = snapshotsToKeep(all, this.now());
    for (const snapshot of all) {
      if (keep.has(snapshot.id)) continue;
      rmSync(this.metaPath(snapshot.id), { force: true });
      rmSync(this.dataPath(snapshot.id), { force: true });
    }
  }

  /** Bytes on disk, for tests and status. */
  size(): number {
    return readdirSync(this.dir)
      .filter(name => name.endsWith('.json.gz'))
      .reduce((sum, name) => sum + statSync(join(this.dir, name)).size, 0);
  }
}

/** Writes a file atomically, 0600. */
export async function writePrivateFile(path: string, data: string | Buffer): Promise<void> {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}
