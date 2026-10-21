import { db, KB_EXPORT_FORMAT } from '@extension/storage';
import { isGzip } from '@src/background/backup/codec';
import { buildSnapshot, parseSnapshot } from '@src/background/backup/snapshot';
import type { Snapshot } from '@src/background/backup/snapshot';
import { STAGED_RESTORE_FILE } from '@src/background/backup/state';
import { BACKUP_MAX_BYTES } from '@src/shared/lib/protocol/companion';

/**
 * Backups as a file: the same snapshot Nex Brain keeps, made here in the page (which reads the same database and
 * storage) and saved as a .json.gz download. A file never holds API keys. Restoring one hands the file to the
 * background through OPFS (too large for a message), and the background checks it again before it writes.
 */

export async function exportBackupFile(): Promise<number> {
  const built = await buildSnapshot({
    db,
    storage: { get: () => chrome.storage.local.get(null) },
    extensionVersion: chrome.runtime.getManifest().version,
  });
  const url = URL.createObjectURL(new Blob([built.bytes], { type: 'application/gzip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `nex-copilot-backup-${new Date(built.createdAt).toISOString().slice(0, 10)}.json.gz`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return built.bytes.length;
}

export type PickedFile =
  | { kind: 'snapshot'; snapshot: Pick<Snapshot, 'createdAt' | 'counts'>; bytes: Uint8Array<ArrayBuffer> }
  // An export from before backups: knowledge items only, merged as before
  | { kind: 'knowledge'; data: unknown };

/** Reads a file the user picked: a backup (gzipped or not), or an old knowledge export. */
export async function readPickedFile(file: File): Promise<PickedFile> {
  if (file.size > BACKUP_MAX_BYTES * 2) throw new Error('This file is too large to be a Nex Copilot backup.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isGzip(bytes)) {
    let parsed: { format?: unknown } | null = null;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('This file is not a Nex Copilot backup.');
    }
    if (parsed?.format === KB_EXPORT_FORMAT) return { kind: 'knowledge', data: parsed };
  }
  const snapshot = await parseSnapshot(bytes);
  return { kind: 'snapshot', snapshot: { createdAt: snapshot.createdAt, counts: snapshot.counts }, bytes };
}

/** Leaves the file where the background reads it for backup_restore_file. */
export async function stageRestoreFile(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(STAGED_RESTORE_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}
