import { db, graphStore, kbStore, workspaceStore } from '@extension/storage';
import type { Workspace } from '@extension/storage';
import { EXPORT_ROOT, readFrontmatter, vaultNotes } from './markdown';

/**
 * The Obsidian vault the user connected: the copilot's memory is written into its `Avi Copilot`
 * folder, and the user's own notes are read into the knowledge base. Runs in an extension page,
 * which holds the folder the user picked; Brave may ask again for access after a restart.
 */

const STORE = 'avi-vault';
// Notes read from the vault: at most this many, and this long
const MAX_NOTES = 3000;
const MAX_NOTE_BYTES = 300_000;
const SKIP_FOLDERS = new Set([EXPORT_ROOT, '.obsidian', '.trash', '.git', 'node_modules']);

type Kept = {
  handle?: FileSystemDirectoryHandle;
  written?: Record<string, string>;
  read?: Record<string, number>;
  readNotes?: boolean;
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function get<K extends keyof Kept>(key: K): Promise<Kept[K]> {
  const store = (await open()).transaction('kv').objectStore('kv');
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result as Kept[K]);
    request.onerror = () => reject(request.error);
  });
}

async function set<K extends keyof Kept>(key: K, value: Kept[K] | undefined): Promise<void> {
  const store = (await open()).transaction('kv', 'readwrite').objectStore('kv');
  await new Promise<void>((resolve, reject) => {
    const request = value === undefined ? store.delete(key) : store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export interface VaultStatus {
  name: string | null;
  // 'granted': syncing; 'prompt': a click is needed to allow access again
  access: 'granted' | 'prompt' | 'denied' | null;
  readNotes: boolean;
}

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};

export async function vaultStatus(): Promise<VaultStatus> {
  const handle = (await get('handle')) as PermissionHandle | undefined;
  const readNotes = (await get('readNotes')) ?? true;
  if (!handle) return { name: null, access: null, readNotes };
  return { name: handle.name, access: await handle.queryPermission({ mode: 'readwrite' }), readNotes };
}

/** Asks the user for their vault folder. Needs a click. */
export async function connectVault(): Promise<void> {
  const picker = (window as unknown as { showDirectoryPicker: (options: object) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  const handle = await picker({ id: 'obsidian-vault', mode: 'readwrite' });
  await set('handle', handle);
  await set('written', {});
  await set('read', {});
}

/** Allows access again after a restart. Needs a click. */
export async function allowVault(): Promise<boolean> {
  const handle = (await get('handle')) as PermissionHandle | undefined;
  return (await handle?.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export async function disconnectVault(): Promise<void> {
  await set('handle', undefined);
  await set('written', undefined);
  await set('read', undefined);
}

export async function setReadNotes(on: boolean): Promise<void> {
  await set('readNotes', on);
}

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function folderAt(root: FileSystemDirectoryHandle, parts: string[], create: boolean) {
  let folder = root;
  for (const part of parts) folder = await folder.getDirectoryHandle(part, { create });
  return folder;
}

async function readFile(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  const parts = path.split('/');
  try {
    const folder = await folderAt(root, parts.slice(0, -1), false);
    return await (await (await folder.getFileHandle(parts.at(-1)!)).getFile()).text();
  } catch {
    return null;
  }
}

/** Writes the copilot's notes: only changed ones, never over a file it did not write, and removes its own stale ones. */
async function writeOut(root: FileSystemDirectoryHandle, files: Map<string, string>): Promise<number> {
  const written = (await get('written')) ?? {};
  const next: Record<string, string> = {};
  let count = 0;
  for (const [path, content] of files) {
    const hash = await sha(content);
    next[path] = hash;
    if (written[path] === hash) continue;
    const existing = await readFile(root, path);
    // A file of the user's own at this path is left alone
    if (existing !== null && !readFrontmatter(existing).ours) {
      delete next[path];
      continue;
    }
    const parts = path.split('/');
    const folder = await folderAt(root, parts.slice(0, -1), true);
    const writable = await (await folder.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
    await writable.write(content);
    await writable.close();
    count++;
  }
  for (const path of Object.keys(written)) {
    if (next[path]) continue;
    const existing = await readFile(root, path);
    if (existing === null || !readFrontmatter(existing).ours) continue;
    const parts = path.split('/');
    await (
      await folderAt(root, parts.slice(0, -1), false).catch(() => null)
    )
      ?.removeEntry(parts.at(-1)!)
      .catch(() => {});
  }
  await set('written', next);
  return count;
}

interface VaultNote {
  path: string;
  title: string;
  text: string;
  workspaceId: string | null;
  modified: number;
}

/** The user's own Markdown notes, outside the copilot's folder and Obsidian's own. */
async function readIn(
  root: FileSystemDirectoryHandle,
  workspaces: Workspace[],
): Promise<{ changed: VaultNote[]; gone: string[] }> {
  const seen = (await get('read')) ?? {};
  const now: Record<string, number> = {};
  const changed: VaultNote[] = [];
  const byName = new Map(workspaces.map(workspace => [workspace.name.trim().toLowerCase(), workspace.id]));

  const walk = async (folder: FileSystemDirectoryHandle, prefix: string) => {
    for await (const [name, entry] of (
      folder as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
    ).entries()) {
      if (Object.keys(now).length >= MAX_NOTES) return;
      if (name.startsWith('.') || SKIP_FOLDERS.has(name)) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') {
        await walk(entry as FileSystemDirectoryHandle, path);
      } else if (name.toLowerCase().endsWith('.md')) {
        const file = await (entry as FileSystemFileHandle).getFile();
        if (file.size > MAX_NOTE_BYTES) continue;
        now[path] = file.lastModified;
        if (seen[path] === file.lastModified) continue;
        const { workspace, ours, body } = readFrontmatter(await file.text());
        if (ours || !body.trim()) continue;
        const top = path.split('/')[0].toLowerCase();
        changed.push({
          path,
          title: name.replace(/\.md$/i, ''),
          text: body,
          workspaceId: (workspace && byName.get(workspace.toLowerCase())) || byName.get(top) || null,
          modified: file.lastModified,
        });
      }
    }
  };
  await walk(root, '');
  await set('read', now);
  return { changed, gone: Object.keys(seen).filter(path => !(path in now)) };
}

let running: Promise<{ written: number; read: number }> | null = null;

/** One sync: the copilot's memory out to the vault, and the user's changed notes in. */
export function syncVault(): Promise<{ written: number; read: number }> {
  running ??= (async () => {
    try {
      const handle = (await get('handle')) as PermissionHandle | undefined;
      if (!handle || (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted')
        return { written: 0, read: 0 };
      const workspaces = await workspaceStore.list();
      const items = await kbStore.items();
      const chunks = await kbStore.chunks();
      const byItem = new Map<string, typeof chunks>();
      for (const chunk of chunks) byItem.set(chunk.itemId, [...(byItem.get(chunk.itemId) ?? []), chunk]);
      const threadIds = items.filter(item => item.sourceType === 'thread').map(item => item.sourceId);
      const messages = await db.messages.where('threadId').anyOf(threadIds).sortBy('seq');
      const meetings = new Map((await db.meetings.toArray()).map(meeting => [meeting.id, meeting]));
      const files = vaultNotes({
        workspaces,
        items,
        chunks: id => byItem.get(id) ?? [],
        messages: id => messages.filter(message => message.threadId === id),
        meeting: id => meetings.get(id),
        nodes: await graphStore.nodes(),
        edges: await graphStore.edges(),
      });
      const written = await writeOut(handle, files);

      let read = 0;
      if ((await get('readNotes')) ?? true) {
        const { changed, gone } = await readIn(handle, workspaces);
        for (let at = 0; at < changed.length; at += 50) {
          await chrome.runtime.sendMessage({ type: 'kb_vault_import', notes: changed.slice(at, at + 50) });
        }
        if (gone.length) await chrome.runtime.sendMessage({ type: 'kb_vault_remove', paths: gone });
        read = changed.length;
      }
      return { written, read };
    } finally {
      running = null;
    }
  })();
  return running;
}
