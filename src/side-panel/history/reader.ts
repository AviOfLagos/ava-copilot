import { classify, walkInto } from '@src/background/history/parse/detect';
import type { FileKind } from '@src/background/history/parse/detect';
import { claudeCodeReader, codexReader } from '@src/background/history/parse/jsonl';
import type { LineReader } from '@src/background/history/parse/jsonl';
import { parseExport, parseGemini, parseVscode, vscodeWorkspaceFolder } from '@src/background/history/parse/json';
import { readZipEntry } from '@src/background/history/parse/zip';
import { BATCH_SIZE, redactConversation } from '@src/background/history/importer';
import type { AiTool, ImportedConversation } from '@src/background/history/tools';

/**
 * Reads the AI history folders the user picked. Runs in the panel, which holds the folders (File System
 * Access, read only; Brave may ask again after a restart). Every conversation is redacted here before
 * it leaves the page, and again in the background. Only files that changed since the last pass are
 * read again (by path, size and time).
 */

const STORE = 'avi-history';
// Caps for one pass: files looked at, conversations brought in, bytes read
const MAX_FILES = 20_000;
const MAX_CONVERSATIONS = 5_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
// A JSON file larger than this is not read whole
const MAX_JSON_BYTES = 300 * 1024 * 1024;
const MAX_DEPTH = 8;
// Hidden folders worth walking into when the user picks their home folder
const TOOL_FOLDERS = new Set(['.claude', '.codex', '.gemini']);

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function get<T>(key: string): Promise<T | undefined> {
  const store = (await open()).transaction('kv').objectStore('kv');
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function set(key: string, value: unknown): Promise<void> {
  const store = (await open()).transaction('kv', 'readwrite').objectStore('kv');
  await new Promise<void>((resolve, reject) => {
    const request = value === undefined ? store.delete(key) : store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
};

/** A one-off command to the background, answered with its reply or thrown as its error. */
export async function historyRequest<T = Record<string, unknown>>(message: Record<string, unknown>): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() })) as
    (T & { type?: string; error?: string }) | undefined;
  if (!reply) throw new Error('The background did not answer.');
  if (reply.type === 'error') throw new Error(reply.error || 'Something went wrong.');
  return reply;
}

/** Asks the user for a folder of AI history and starts an import for it. Needs a click. */
export async function addFolder(): Promise<string> {
  const picker = (window as unknown as { showDirectoryPicker: (options: object) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  const handle = await picker({ id: 'ai-history', mode: 'read' });
  const { importId } = await historyRequest<{ importId: string }>({ type: 'history_add_import', label: handle.name });
  await set(`handle:${importId}`, handle);
  await set(`seen:${importId}`, {});
  return importId;
}

/** Whether a folder can be read now: 'prompt' needs a click to allow it again, null means it is gone. */
export async function folderAccess(importId: string): Promise<PermissionState | null> {
  const handle = await get<PermissionHandle>(`handle:${importId}`);
  return handle ? handle.queryPermission({ mode: 'read' }) : null;
}

/** Allows reading a folder again after a restart. Needs a click. */
export async function allowFolder(importId: string): Promise<boolean> {
  const handle = await get<PermissionHandle>(`handle:${importId}`);
  return (await handle?.requestPermission({ mode: 'read' })) === 'granted';
}

/** Forgets an import: its items leave the knowledge base, and the folder is let go. */
export async function forgetImport(importId: string): Promise<number> {
  const { removed } = await historyRequest<{ removed: number }>({ type: 'history_forget', importId });
  await set(`handle:${importId}`, undefined);
  await set(`seen:${importId}`, undefined);
  return removed;
}

export interface ImportProgress {
  phase: 'scanning' | 'reading' | 'done' | 'cancelled';
  filesTotal: number;
  filesDone: number;
  conversations: number;
  added: number;
  updated: number;
  unchanged: number;
  redacted: number;
  capped: boolean;
}

interface Found {
  path: string;
  kind: FileKind;
  handle: FileSystemFileHandle;
  // VS Code: the project folder its workspace.json names
  project: string | null;
}

async function* entries(folder: FileSystemDirectoryHandle): AsyncIterable<[string, FileSystemHandle]> {
  yield* (folder as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
}

/** Every file in the folder that holds conversations, with what reads it. */
async function scan(root: FileSystemDirectoryHandle, signal: AbortSignal): Promise<Found[]> {
  const found: Found[] = [];
  const walk = async (folder: FileSystemDirectoryHandle, prefix: string, depth: number, project: string | null) => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES || signal.aborted) return;
    const children: [string, FileSystemHandle][] = [];
    for await (const entry of entries(folder)) children.push(entry);
    // A VS Code workspace folder says which project its chats belong to
    const workspaceFile = children.find(([name, entry]) => name === 'workspace.json' && entry.kind === 'file');
    if (workspaceFile && children.some(([name]) => name === 'chatSessions')) {
      const text = await (await (workspaceFile[1] as FileSystemFileHandle).getFile()).text();
      project = vscodeWorkspaceFolder(text) ?? project;
    }
    for (const [name, entry] of children) {
      if (found.length >= MAX_FILES) return;
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') {
        if (name.startsWith('.') && !TOOL_FOLDERS.has(name)) continue;
        if (!walkInto(name)) continue;
        await walk(entry as FileSystemDirectoryHandle, path, depth + 1, project);
      } else {
        const kind = classify(path);
        if (kind) found.push({ path, kind, handle: entry as FileSystemFileHandle, project });
      }
    }
  };
  await walk(root, '', 0, null);
  return found;
}

/** Feeds a file to a line reader without holding all of it in memory. */
async function readLines(file: File, reader: LineReader, signal: AbortSignal): Promise<ImportedConversation[]> {
  const stream = file.stream().pipeThrough(new TextDecoderStream());
  let rest = '';
  for await (const piece of stream as unknown as AsyncIterable<string>) {
    if (signal.aborted) break;
    const lines = (rest + piece).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) reader.line(line);
  }
  if (rest) reader.line(rest);
  return reader.end();
}

async function parseFile(found: Found, file: File, signal: AbortSignal): Promise<ImportedConversation[]> {
  const fallback = file.lastModified;
  switch (found.kind.format) {
    case 'claude-jsonl':
      return readLines(file, claudeCodeReader(found.path, fallback), signal);
    case 'codex-jsonl':
      return readLines(file, codexReader(found.path, fallback), signal);
    case 'gemini-json':
      return file.size > MAX_JSON_BYTES ? [] : parseGemini(found.path, await file.text(), fallback);
    case 'vscode-chat':
      return file.size > MAX_JSON_BYTES ? [] : parseVscode(found.path, await file.text(), found.project, fallback);
    case 'export-json':
      return file.size > MAX_JSON_BYTES ? [] : parseExport(await file.text(), fallback);
    case 'export-zip': {
      const text = await readZipEntry(file, name => /(^|\/)conversations\.json$/.test(name));
      return text ? parseExport(text, fallback) : [];
    }
  }
}

/**
 * One pass over an import's folder: changed files are read, their conversations redacted and sent to
 * the background in batches. `full` reads every file again. Stops cleanly when the signal aborts: what
 * was sent stays, and the next pass picks up the rest.
 */
export async function runImport(
  importId: string,
  options: { full?: boolean; signal: AbortSignal; onProgress: (progress: ImportProgress) => void },
): Promise<ImportProgress> {
  const { signal, onProgress } = options;
  const handle = await get<PermissionHandle>(`handle:${importId}`);
  if (!handle) throw new Error('This folder is no longer connected. Add it again.');
  if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') {
    throw new Error('Allow the folder again first.');
  }
  const seen: Record<string, string> = options.full
    ? {}
    : ((await get<Record<string, string>>(`seen:${importId}`)) ?? {});
  const progress: ImportProgress = {
    phase: 'scanning',
    filesTotal: 0,
    filesDone: 0,
    conversations: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    redacted: 0,
    capped: false,
  };
  const report = () => onProgress({ ...progress });
  report();

  const found = await scan(handle, signal);
  progress.capped = found.length >= MAX_FILES;
  // The newest first, so the caps keep what matters now
  const files: { found: Found; file: File }[] = [];
  for (const item of found) files.push({ found: item, file: await item.handle.getFile() });
  files.sort((a, b) => b.file.lastModified - a.file.lastModified);
  progress.phase = 'reading';
  progress.filesTotal = files.length;
  report();

  const tools = new Set<AiTool>();
  let batch: ImportedConversation[] = [];
  // Files whose conversations are all in sent batches: only then marked as read
  let pending: [string, string][] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length) {
      const counts = await historyRequest<{ added: number; updated: number; unchanged: number; redacted: number }>({
        type: 'history_import_batch',
        importId,
        conversations: batch,
        force: options.full ?? false,
      });
      progress.added += counts.added;
      progress.updated += counts.updated;
      progress.unchanged += counts.unchanged;
      progress.redacted += counts.redacted;
      batch = [];
    }
    for (const [path, signature] of pending) seen[path] = signature;
    pending = [];
    await set(`seen:${importId}`, seen);
    report();
  };

  for (const { found: item, file } of files) {
    if (signal.aborted) break;
    if (progress.conversations >= MAX_CONVERSATIONS || bytes >= MAX_BYTES) {
      progress.capped = true;
      break;
    }
    const signature = `${file.size}:${file.lastModified}`;
    progress.filesDone++;
    if (seen[item.path] === signature) continue;
    bytes += file.size;
    let conversations: ImportedConversation[] = [];
    try {
      conversations = await parseFile(item, file, signal);
    } catch {
      // A file that is not what its name says is skipped, and tried again next time
      continue;
    }
    if (signal.aborted) break;
    for (const conversation of conversations.slice(0, MAX_CONVERSATIONS - progress.conversations)) {
      // Secrets never leave the page: the background takes them out again too
      const redacted = redactConversation(conversation);
      progress.redacted += redacted.count;
      batch.push(redacted.conversation);
      tools.add(conversation.tool);
      progress.conversations++;
      if (batch.length >= BATCH_SIZE) await flush();
    }
    pending.push([item.path, signature]);
    if (progress.filesDone % 25 === 0) await flush();
    else report();
  }
  await flush();
  progress.phase = signal.aborted ? 'cancelled' : 'done';
  await historyRequest({
    type: 'history_import_done',
    importId,
    tools: [...tools],
    counts: {
      added: progress.added,
      updated: progress.updated,
      unchanged: progress.unchanged,
      redacted: progress.redacted,
      capped: progress.capped,
    },
  });
  report();
  return progress;
}
