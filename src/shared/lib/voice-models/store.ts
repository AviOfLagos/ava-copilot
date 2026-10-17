import { AppError, kindOfStatus, toAppError } from '../errors/errors';
import { withRetry } from '../retry/retry';
import { activeCatalog, VOSK_MODEL_DIR } from './catalog';
import type { CatalogComponent, CatalogFile, VoiceModelCatalog, VoiceModelComponentId } from './catalog';
import { kittenVoiceFiles, voskArchive } from './unpack';
import type { OutputFile } from './unpack';

/**
 * The voice models downloaded on first use, kept in the extension's private file system (OPFS) under
 * `voice-models/<component>/`, in the same layout as the packed `voice/<component>/` folders. A file is
 * downloaded to `<name>.part` (resumed with a Range request after a stop or a lost connection), checked against
 * its pinned SHA-256 and only then given its real name; a component counts as downloaded only once every file is
 * in place and unpacked and its `.ready.json` is written. One download at a time across every extension page
 * (a Web Lock).
 */

export const MODELS_DIR = 'voice-models';
export const READY_FILE = '.ready.json';
// Written data is committed this often, so a stop loses at most this much
const CHECKPOINT_BYTES = 8 * 1024 * 1024;
const LOCK = 'nex-voice-models';

export interface ReadyMarker {
  // The sums of the files it came from: a new pinned revision downloads again
  files: string[];
  bytes: number;
  at: number;
}

export interface DownloadProgress {
  id: VoiceModelComponentId;
  received: number;
  total: number;
}

export interface StoreDeps {
  root?: () => Promise<FileSystemDirectoryHandle>;
  fetch?: typeof fetch;
  catalog?: VoiceModelCatalog;
  // Runs the work alone across pages
  lock?: <T>(work: () => Promise<T>) => Promise<T>;
  // Stand-in for tests: no waiting between retries
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultRoot = () => navigator.storage.getDirectory();

function defaultLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  return locks ? (locks.request(LOCK, work) as Promise<T>) : work();
}

async function modelsRoot(deps: StoreDeps, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await (deps.root ?? defaultRoot)()).getDirectoryHandle(MODELS_DIR, { create });
  } catch {
    return null;
  }
}

/** A folder inside another one (`a/b`), made when asked. */
async function folder(
  base: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  let dir = base;
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch {
      return null;
    }
  }
  return dir;
}

function split(path: string): { dirs: string[]; name: string } {
  const parts = path.split('/').filter(Boolean);
  return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] ?? '' };
}

async function fileHandle(
  base: FileSystemDirectoryHandle,
  path: string,
  create = false,
): Promise<FileSystemFileHandle | null> {
  const { dirs, name } = split(path);
  const dir = await folder(base, dirs, create);
  if (!dir) return null;
  try {
    return await dir.getFileHandle(name, { create });
  } catch {
    return null;
  }
}

async function removeFile(base: FileSystemDirectoryHandle, path: string): Promise<void> {
  const { dirs, name } = split(path);
  const dir = await folder(base, dirs, false);
  await dir?.removeEntry(name).catch(() => {});
}

async function writeFile(base: FileSystemDirectoryHandle, path: string, data: OutputFile['data'] | Blob) {
  const handle = await fileHandle(base, path, true);
  if (!handle) throw new AppError('unavailable', `Could not write ${path}`, { retryable: false });
  const writable = await handle.createWritable();
  try {
    await writable.write(data as FileSystemWriteChunkType);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function readMarker(dir: FileSystemDirectoryHandle): Promise<ReadyMarker | null> {
  const handle = await fileHandle(dir, READY_FILE);
  if (!handle) return null;
  try {
    const marker = JSON.parse(await (await handle.getFile()).text()) as ReadyMarker;
    return Array.isArray(marker.files) ? marker : null;
  } catch {
    return null;
  }
}

const sums = (component: CatalogComponent) => component.files.map(file => file.sha256);
const sameSums = (marker: ReadyMarker, component: CatalogComponent) =>
  marker.files.length === component.files.length && sums(component).every((sum, i) => marker.files[i] === sum);

/** The components downloaded and ready, with their size on disk. */
export async function downloadedModels(
  deps: StoreDeps = {},
): Promise<Partial<Record<VoiceModelComponentId, { bytes: number }>>> {
  const root = await modelsRoot(deps, false);
  const ready: Partial<Record<VoiceModelComponentId, { bytes: number }>> = {};
  if (!root) return ready;
  for (const id of Object.keys(deps.catalog ?? activeCatalog()) as VoiceModelComponentId[]) {
    const dir = await folder(root, [id], false);
    const marker = dir && (await readMarker(dir));
    if (marker) ready[id] = { bytes: marker.bytes };
  }
  return ready;
}

/** A downloaded component's file, or null when the component is not (fully) downloaded or has no such file. */
export async function openModelFile(
  id: VoiceModelComponentId,
  path: string,
  deps: Pick<StoreDeps, 'root'> = {},
): Promise<File | null> {
  const root = await modelsRoot(deps, false);
  const dir = root && (await folder(root, [id], false));
  if (!dir || !(await readMarker(dir))) return null;
  const handle = await fileHandle(dir, path);
  return handle ? handle.getFile() : null;
}

/** Deletes a downloaded component. */
export async function removeModel(id: VoiceModelComponentId, deps: StoreDeps = {}): Promise<void> {
  const root = await modelsRoot(deps, false);
  await (deps.lock ?? defaultLock)(async () => {
    await root?.removeEntry(id, { recursive: true }).catch(() => {});
  });
}

async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function rename(dir: FileSystemDirectoryHandle, from: FileSystemFileHandle, path: string): Promise<void> {
  const target = split(path).name;
  const movable = from as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
  if (typeof movable.move === 'function') {
    await movable.move(target);
    return;
  }
  // No move(): copy, then drop the partial file
  await writeFile(dir, path, await from.getFile());
  await removeFile(dir, `${path}.part`);
}

/** The size of a component file already in place under its real name (it was checked before it got it). */
async function finishedSize(dir: FileSystemDirectoryHandle, file: CatalogFile): Promise<number> {
  const handle = await fileHandle(dir, file.path);
  if (!handle) return 0;
  const size = (await handle.getFile()).size;
  return size === file.bytes ? size : 0;
}

/** What is already there of a file: all of it under its real name, else its partial copy. */
async function bytesInPlace(dir: FileSystemDirectoryHandle, file: CatalogFile): Promise<number> {
  const finished = await finishedSize(dir, file);
  if (finished) return finished;
  const part = await fileHandle(dir, `${file.path}.part`);
  return part ? Math.min((await part.getFile()).size, file.bytes) : 0;
}

/**
 * One file: resumed from its partial copy when there is one, checked, then renamed. `onBytes` hears every chunk
 * written, and a negative count when a partial copy had to be thrown away.
 */
async function downloadFile(
  dir: FileSystemDirectoryHandle,
  file: CatalogFile,
  { fetcher, signal, onBytes }: { fetcher: typeof fetch; signal?: AbortSignal; onBytes: (delta: number) => void },
): Promise<void> {
  if (await finishedSize(dir, file)) return;
  const part = await fileHandle(dir, `${file.path}.part`, true);
  if (!part) throw new AppError('unavailable', `Could not write ${file.path}`, { retryable: false });
  let have = (await part.getFile()).size;
  let writable = await part.createWritable({ keepExistingData: true });
  try {
    if (have > file.bytes) {
      await writable.truncate(0);
      onBytes(-have);
      have = 0;
    }
    if (have < file.bytes) {
      const response = await fetcher(file.url, {
        headers: have ? { Range: `bytes=${have}-` } : {},
        signal,
        credentials: 'omit',
      });
      if (!response.ok) {
        throw new AppError(kindOfStatus(response.status), `${file.path}: HTTP ${response.status}`, {
          status: response.status,
        });
      }
      const resumed = have > 0 && response.status === 206 && contentRangeStart(response) === have;
      if (!resumed && have > 0) {
        // The server sent the whole file again
        await writable.truncate(0);
        onBytes(-have);
        have = 0;
      }
      await writable.seek(have);
      const reader = response.body!.getReader();
      let sinceCheckpoint = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value as FileSystemWriteChunkType);
        have += value.length;
        sinceCheckpoint += value.length;
        onBytes(value.length);
        if (have > file.bytes) break;
        if (sinceCheckpoint >= CHECKPOINT_BYTES) {
          await writable.close();
          writable = await part.createWritable({ keepExistingData: true });
          await writable.seek(have);
          sinceCheckpoint = 0;
        }
      }
    }
    // Kept for a resume even when stopped or cut off
    await writable.close();
  } catch (error) {
    await writable.close().catch(() => {});
    throw error;
  }
  const copy = await part.getFile();
  if (copy.size < file.bytes) {
    throw new AppError('network', `${file.path} was cut off`);
  }
  if (copy.size > file.bytes || (await sha256Hex(copy)) !== file.sha256) {
    await removeFile(dir, `${file.path}.part`);
    onBytes(-copy.size);
    throw new AppError('invalid', `${file.path} is not the file that was pinned (checksum mismatch)`, {
      retryable: false,
    });
  }
  await rename(dir, part, file.path);
}

function contentRangeStart(response: Response): number | null {
  const match = /^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '');
  return match ? Number(match[1]) : null;
}

async function readText(dir: FileSystemDirectoryHandle, path: string): Promise<string> {
  const handle = await fileHandle(dir, path);
  if (!handle) throw new AppError('not_found', `${path} is missing`);
  return (await handle.getFile()).text();
}

async function readBytes(dir: FileSystemDirectoryHandle, path: string): Promise<Uint8Array> {
  const handle = await fileHandle(dir, path);
  if (!handle) throw new AppError('not_found', `${path} is missing`);
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

/** Turns the checked downloads into what the runtime reads; returns the files it consumed. */
async function unpack(dir: FileSystemDirectoryHandle, component: CatalogComponent): Promise<string[]> {
  if (component.unpack === 'kitten-voices') {
    const outputs = await kittenVoiceFiles(await readText(dir, 'kitten.json'), await readBytes(dir, 'voices.npz'));
    for (const output of outputs) await writeFile(dir, output.path, output.data);
    return ['voices.npz'];
  }
  if (component.unpack === 'vosk-model') {
    const { tarGz, words } = voskArchive(await readBytes(dir, 'model.zip'), VOSK_MODEL_DIR);
    const handle = await fileHandle(dir, 'model.tar.gz.part', true);
    if (!handle) throw new AppError('unavailable', 'Could not write model.tar.gz', { retryable: false });
    const writable = await handle.createWritable();
    try {
      const reader = tarGz.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value as FileSystemWriteChunkType);
      }
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    await rename(dir, handle, 'model.tar.gz');
    await writeFile(dir, 'words.txt', `${(await words).join('\n')}\n`);
    return ['model.zip'];
  }
  return [];
}

async function folderBytes(dir: FileSystemDirectoryHandle): Promise<number> {
  let total = 0;
  for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (handle.kind === 'directory') total += await folderBytes(handle as FileSystemDirectoryHandle);
    else total += (await (handle as FileSystemFileHandle).getFile()).size;
  }
  return total;
}

/**
 * Downloads the components not yet downloaded, one after another, under the cross-page lock. Each file is retried
 * (resuming) after a lost connection; a checksum mismatch or a stop ends the download with an AppError
 * ('invalid' / 'cancelled'), and what was checked so far is kept.
 */
export async function downloadModels(
  ids: VoiceModelComponentId[],
  { signal, onProgress }: { signal?: AbortSignal; onProgress?: (progress: DownloadProgress) => void } = {},
  deps: StoreDeps = {},
): Promise<void> {
  const catalog = deps.catalog ?? activeCatalog();
  const fetcher = deps.fetch ?? fetch.bind(globalThis);
  await (deps.lock ?? defaultLock)(async () => {
    const root = await modelsRoot(deps, true);
    if (!root)
      throw new AppError('unavailable', 'This browser gives the extension no file storage', { retryable: false });
    for (const id of ids) {
      if (signal?.aborted) throw new AppError('cancelled', 'Stopped.');
      const component = catalog[id];
      if (!component) continue;
      let dir = (await folder(root, [id], true))!;
      const marker = await readMarker(dir);
      if (marker && sameSums(marker, component)) continue;
      if (marker) {
        // A new pinned revision: nothing of the old one is reused
        await root.removeEntry(id, { recursive: true }).catch(() => {});
        dir = (await folder(root, [id], true))!;
      }

      const total = component.files.reduce((sum, file) => sum + file.bytes, 0);
      let received = 0;
      for (const file of component.files) received += await bytesInPlace(dir, file);
      const report = () => onProgress?.({ id, received: Math.max(0, Math.min(received, total)), total });
      report();
      for (const file of component.files) {
        await withRetry(
          async () => {
            await downloadFile(dir, file, {
              fetcher,
              signal,
              onBytes: delta => {
                received += delta;
                report();
              },
            });
          },
          { attempts: 4, baseMs: 1000, capMs: 15_000, signal, sleep: deps.sleep },
        ).catch(error => {
          throw signal?.aborted ? new AppError('cancelled', 'Stopped.') : toAppError(error);
        });
      }
      const consumed = await unpack(dir, component);
      let consumedBytes = 0;
      for (const path of consumed) consumedBytes += (await (await fileHandle(dir, path))?.getFile())?.size ?? 0;
      const ready: ReadyMarker = {
        files: sums(component),
        bytes: (await folderBytes(dir)) - consumedBytes,
        at: Date.now(),
      };
      await writeFile(dir, READY_FILE, JSON.stringify(ready));
      // Only after the marker: a stop in between never leaves a component without what it was unpacked from
      for (const path of consumed) await removeFile(dir, path);
      received = total;
      report();
    }
  });
}
