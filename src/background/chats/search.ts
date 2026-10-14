import type { ThreadMessage, ThreadRecord } from '@extension/storage';

/**
 * Finding things in the user's other chats, for Ava and the agent: every chat's title and messages, matched by
 * the words asked for. Pure, so the ranking is tested without a database.
 */

export interface ChatHit {
  threadId: string;
  title: string;
  updatedAt: number;
  workspaceId: string | null;
  // In the workspace the search was asked from
  inWorkspace: boolean;
  // How many of the query's words the chat has, in its title or messages
  matched: number;
  snippet: string;
}

export const SNIPPET_CHARS = 200;
export const DEFAULT_LIMIT = 8;

/** The words of a query worth matching: lowercase, two characters or more, each once. */
export function queryWords(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(word => word.length >= 2),
    ),
  ];
}

/** A window of `text` around the first of `words` it contains, on one line. */
export function snippetOf(text: string, words: string[], size = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= size) return flat;
  const lower = flat.toLowerCase();
  const at = Math.min(...words.map(word => lower.indexOf(word)).filter(index => index >= 0), flat.length);
  const start = at >= flat.length ? 0 : Math.max(0, at - Math.floor(size / 3));
  const piece = flat.slice(start, start + size).trim();
  return `${start > 0 ? '…' : ''}${piece}${start + size < flat.length ? '…' : ''}`;
}

/**
 * Chats that match a query: those with at least half its words (and at least one) in their title or messages.
 * Chats in the workspace asked from come first; then those with every word; then the newest.
 */
export function rankChats(
  threads: Pick<ThreadRecord, 'id' | 'title' | 'updatedAt' | 'workspaceId'>[],
  messages: Pick<ThreadMessage, 'threadId' | 'content' | 'actor' | 'ts'>[],
  query: string,
  {
    workspaceId = null,
    exclude = [],
    limit = DEFAULT_LIMIT,
  }: { workspaceId?: string | null; exclude?: string[]; limit?: number } = {},
): ChatHit[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const byThread = new Map<string, typeof messages>();
  for (const message of messages) {
    // Notes the copilot adds (workspace moves, retries) are not what was said
    if (message.actor === 'system') continue;
    const list = byThread.get(message.threadId) ?? [];
    list.push(message);
    byThread.set(message.threadId, list);
  }
  const need = Math.max(1, Math.ceil(words.length / 2));
  const hits: ChatHit[] = [];
  for (const thread of threads) {
    if (exclude.includes(thread.id)) continue;
    const said = (byThread.get(thread.id) ?? []).slice().sort((a, b) => b.ts - a.ts);
    const title = thread.title.toLowerCase();
    const found = words.filter(word => title.includes(word) || said.some(m => m.content.toLowerCase().includes(word)));
    if (found.length < need) continue;
    // The newest message with the most of the words found, else the newest message, else the title
    let best: (typeof said)[number] | undefined;
    let bestCount = 0;
    for (const message of said) {
      const text = message.content.toLowerCase();
      const count = found.filter(word => text.includes(word)).length;
      if (count > bestCount) {
        best = message;
        bestCount = count;
      }
    }
    best ??= said[0];
    hits.push({
      threadId: thread.id,
      title: thread.title,
      updatedAt: thread.updatedAt,
      workspaceId: thread.workspaceId ?? null,
      inWorkspace: Boolean(workspaceId) && thread.workspaceId === workspaceId,
      matched: found.length,
      snippet: best ? snippetOf(best.content, found) : '',
    });
  }
  const full = (hit: ChatHit) => (hit.matched === words.length ? 1 : 0);
  return hits
    .sort((a, b) => Number(b.inWorkspace) - Number(a.inWorkspace) || full(b) - full(a) || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The hits as the model reads them. Inside a workspace, its own chats come first, and anything from elsewhere is
 * said to be from elsewhere.
 */
export function describeHits(
  hits: ChatHit[],
  query: string,
  workspace: { id: string; name: string } | null,
  workspaceNames: Map<string, string>,
): string {
  if (!hits.length) {
    return workspace
      ? `No chat matches "${query}", in "${workspace.name}" or anywhere else.`
      : `No chat matches "${query}".`;
  }
  const line = (hit: ChatHit) => {
    const place = hit.workspaceId ? (workspaceNames.get(hit.workspaceId) ?? 'another workspace') : 'no workspace';
    return `- id ${hit.threadId} | "${hit.title || 'Untitled chat'}" | ${day(hit.updatedAt)} | ${place}${
      hit.snippet ? `\n  ${hit.snippet}` : ''
    }`;
  };
  if (!workspace) return `Chats matching "${query}", newest first:\n${hits.map(line).join('\n')}`;
  const own = hits.filter(hit => hit.inWorkspace);
  const other = hits.filter(hit => !hit.inWorkspace);
  const parts = [
    own.length
      ? `In the workspace "${workspace.name}":\n${own.map(line).join('\n')}`
      : `Nothing in the workspace "${workspace.name}" matches "${query}".`,
  ];
  if (other.length)
    parts.push(`From chats outside "${workspace.name}" (say so when you use them):\n${other.map(line).join('\n')}`);
  return parts.join('\n\n');
}

export const READ_LAST = 20;
// Past this, the older part of what is read is summarised
export const READ_MAX_CHARS = 6000;
// Kept word for word when the rest is summarised
export const READ_KEEP = 6;

const SPEAKER: Record<string, string> = { user: 'User', planner: 'Assistant', navigator: 'Browser' };

export function chatLines(messages: Pick<ThreadMessage, 'actor' | 'content' | 'attachments'>[]): string[] {
  return messages
    .filter(message => message.actor !== 'system')
    .map(message => {
      const attached = message.attachments?.length
        ? ` [attached: ${message.attachments.map(item => item.name).join(', ')}]`
        : '';
      return `${SPEAKER[message.actor] ?? message.actor}: ${message.content.replace(/\s+/g, ' ').trim()}${attached}`;
    });
}

/**
 * The last `count` messages of a chat as plain lines. When that is long, all but the last few are summarised
 * by `summarise` (or cut, when it fails or is not given).
 */
export async function readChatText(
  thread: Pick<ThreadRecord, 'title' | 'updatedAt'>,
  messages: Pick<ThreadMessage, 'actor' | 'content' | 'attachments'>[],
  count = READ_LAST,
  summarise?: (text: string) => Promise<string>,
): Promise<string> {
  const lines = chatLines(messages).slice(-Math.max(1, Math.min(count, 100)));
  const header = `Chat "${thread.title || 'Untitled chat'}", last active ${day(thread.updatedAt)}, its last ${lines.length} messages:`;
  if (!lines.length) return `Chat "${thread.title || 'Untitled chat'}" has no messages.`;
  const body = lines.join('\n');
  if (body.length <= READ_MAX_CHARS) return `${header}\n${body}`;
  const older = lines.slice(0, -READ_KEEP).join('\n');
  const recent = lines.slice(-READ_KEEP).map(text => (text.length > 800 ? `${text.slice(0, 800)}…` : text));
  let summary = '';
  if (summarise) summary = (await summarise(older).catch(() => '')).trim();
  if (!summary) summary = `${older.slice(0, 2000)}…`;
  return `${header}\nSummary of the earlier part:\n${summary}\n\nThe last ${recent.length} messages:\n${recent.join('\n')}`;
}
