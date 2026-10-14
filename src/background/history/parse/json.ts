import type { ImportedConversation, ImportedTurn } from '../tools';
import { finish, pushTurn, textParts, toMs } from './common';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * Gemini CLI: `~/.gemini/tmp/<project hash>/chats/session-*.json` holds one session (`messages` of type
 * `user` / `gemini`); older versions keep `logs.json` (what the user typed, by session) and
 * `checkpoint-*.json` (the model's history as `role` / `parts`). The folder is named by a hash of the
 * project path, so the project is not known.
 */

// Keys that would reach the object machinery instead of the file's own data
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function safeKey(key: unknown): boolean {
  return (
    (typeof key === 'number' && Number.isInteger(key) && key >= 0) || (typeof key === 'string' && !UNSAFE_KEYS.has(key))
  );
}

export function parseGemini(path: string, text: string, fallbackTime: number): ImportedConversation[] {
  const data: unknown = JSON.parse(text);
  const name = path.split('/').pop() ?? '';
  const out: ImportedConversation[] = [];

  if (isObject(data) && Array.isArray(data.messages)) {
    const turns: ImportedTurn[] = [];
    for (const message of data.messages.filter(isObject)) {
      const role =
        message.type === 'user' ? 'user' : message.type === 'gemini' || message.type === 'model' ? 'assistant' : null;
      if (role) pushTurn(turns, role, textParts(message.content), toMs(message.timestamp));
    }
    const conversation = finish(
      {
        id: str(data.sessionId) ?? name.replace(/\.json$/, ''),
        tool: 'gemini-cli',
        title: str(data.summary),
        project: null,
        branch: null,
        startedAt: toMs(data.startTime),
        updatedAt: toMs(data.lastUpdated),
      },
      turns,
      fallbackTime,
    );
    if (conversation) out.push(conversation);
    return out;
  }

  if (Array.isArray(data) && name === 'logs.json') {
    const sessions = new Map<string, ImportedTurn[]>();
    for (const entry of data.filter(isObject)) {
      if (entry.type !== 'user' || typeof entry.message !== 'string') continue;
      const id = str(entry.sessionId) ?? 'session';
      if (!sessions.has(id)) sessions.set(id, []);
      pushTurn(sessions.get(id)!, 'user', entry.message, toMs(entry.timestamp));
      // Each line typed is its own turn, so they are kept apart
      sessions.get(id)!.push({ role: 'assistant', text: '', at: null });
    }
    for (const [id, turns] of sessions) {
      const conversation = finish(
        { id, tool: 'gemini-cli', title: null, project: null, branch: null, startedAt: null, updatedAt: null },
        turns.filter(turn => turn.text),
        fallbackTime,
      );
      if (conversation) out.push(conversation);
    }
    return out;
  }

  if (Array.isArray(data) && /^checkpoint/.test(name)) {
    const turns: ImportedTurn[] = [];
    for (const content of data.filter(isObject)) {
      const role = content.role === 'user' ? 'user' : content.role === 'model' ? 'assistant' : null;
      if (role) pushTurn(turns, role, textParts(content.parts), null);
    }
    const conversation = finish(
      {
        id: `${path.split('/').at(-2) ?? ''}/${name.replace(/\.json$/, '')}`,
        tool: 'gemini-cli',
        title: null,
        project: null,
        branch: null,
        startedAt: null,
        updatedAt: null,
      },
      turns,
      fallbackTime,
    );
    if (conversation) out.push(conversation);
  }
  return out;
}

/** The text of one VS Code chat response: its Markdown parts, without tool and progress parts. */
function vscodeResponse(response: unknown): string {
  if (!Array.isArray(response)) return '';
  return response
    .filter(isObject)
    .filter(part => (part.kind === undefined || part.kind === 'markdownContent') && 'value' in part)
    .map(part => {
      const value = part.value;
      if (typeof value === 'string') return value;
      return isObject(value) && typeof value.value === 'string' ? value.value : '';
    })
    .join('');
}

/**
 * Replays a VS Code `.jsonl` chat log: line kind 0 is the whole session, kind 1 sets the value at a
 * path, kind 2 appends to the array at a path.
 */
function replayVscode(text: string): Json | null {
  let root: Json | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let op: { kind?: number; k?: (string | number)[]; v?: unknown; i?: number };
    try {
      op = JSON.parse(line);
    } catch {
      continue;
    }
    if (op.kind === 0 && isObject(op.v)) {
      root = op.v;
      continue;
    }
    if (!root || !Array.isArray(op.k) || op.k.length === 0) continue;
    // A path from the file only ever names plain keys or indexes, and only walks what the file itself built
    if (!op.k.every(safeKey)) continue;
    let target: unknown = root;
    for (const key of op.k.slice(0, -1)) {
      target =
        target && typeof target === 'object' && Object.prototype.hasOwnProperty.call(target, key)
          ? (target as Record<string | number, unknown>)[key as string | number]
          : undefined;
    }
    const last = op.k.at(-1)!;
    if (!target || typeof target !== 'object') continue;
    const holder = target as Record<string | number, unknown>;
    if (op.kind === 1) holder[last] = op.v;
    if (op.kind === 2) {
      const list = Array.isArray(holder[last]) ? (holder[last] as unknown[]) : [];
      const items = Array.isArray(op.v) ? op.v : [op.v];
      if (typeof op.i === 'number') list.splice(op.i, list.length - op.i, ...items);
      else list.push(...items);
      holder[last] = list;
    }
  }
  return root;
}

/**
 * VS Code's chat (Copilot and other chat agents): `workspaceStorage/<hash>/chatSessions/<id>.json`, or
 * `.jsonl` as an edit log in newer versions. The project folder comes from that hash folder's
 * `workspace.json`, which the caller passes in.
 */
export function parseVscode(
  path: string,
  text: string,
  project: string | null,
  fallbackTime: number,
): ImportedConversation[] {
  const data = path.endsWith('.jsonl') ? replayVscode(text) : (JSON.parse(text) as unknown);
  if (!isObject(data) || !Array.isArray(data.requests)) return [];
  const turns: ImportedTurn[] = [];
  for (const request of data.requests.filter(isObject)) {
    const message = isObject(request.message) ? request.message : {};
    const at = toMs(request.timestamp);
    pushTurn(turns, 'user', str(message.text) ?? '', at);
    pushTurn(turns, 'assistant', vscodeResponse(request.response), toMs(request.responseTimestamp) ?? at);
  }
  const conversation = finish(
    {
      id: str(data.sessionId) ?? (path.split('/').pop() ?? '').replace(/\.jsonl?$/, ''),
      tool: 'vscode',
      title: str(data.customTitle),
      project,
      branch: null,
      startedAt: toMs(data.creationDate),
      updatedAt: toMs(data.lastMessageDate),
    },
    turns,
    fallbackTime,
  );
  return conversation ? [conversation] : [];
}

/** The project folder in a VS Code `workspace.json`: `{ "folder": "file:///Users/…" }`. */
export function vscodeWorkspaceFolder(text: string): string | null {
  try {
    const data = JSON.parse(text) as { folder?: unknown; workspace?: unknown };
    const uri = str(data.folder) ?? str(data.workspace);
    if (!uri) return null;
    return decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\.code-workspace$/, '') || null;
  } catch {
    return null;
  }
}

/** One ChatGPT conversation: the branch the user last saw, from its current node back to the root. */
function chatgptConversation(data: Json, fallbackTime: number): ImportedConversation | null {
  const mapping = isObject(data.mapping) ? data.mapping : {};
  const path: Json[] = [];
  let nodeId = str(data.current_node);
  const seen = new Set<string>();
  while (nodeId && !seen.has(nodeId) && isObject(mapping[nodeId])) {
    seen.add(nodeId);
    const node = mapping[nodeId] as Json;
    if (isObject(node.message)) path.unshift(node.message);
    nodeId = str(node.parent);
  }
  // No current node: the nodes in the order they were written
  if (path.length === 0) {
    for (const node of Object.values(mapping)) if (isObject(node) && isObject(node.message)) path.push(node.message);
    path.sort((a, b) => (toMs(a.create_time) ?? 0) - (toMs(b.create_time) ?? 0));
  }
  const turns: ImportedTurn[] = [];
  for (const message of path) {
    const role = isObject(message.author) ? message.author.role : null;
    if (role !== 'user' && role !== 'assistant') continue;
    const metadata = isObject(message.metadata) ? message.metadata : {};
    if (metadata.is_visually_hidden_from_conversation) continue;
    const content = isObject(message.content) ? message.content : {};
    if (!['text', 'multimodal_text'].includes(String(content.content_type))) continue;
    const parts = Array.isArray(content.parts) ? content.parts.filter(part => typeof part === 'string') : [];
    pushTurn(turns, role, parts.join('\n'), toMs(message.create_time));
  }
  return finish(
    {
      id: str(data.conversation_id) ?? str(data.id) ?? `${toMs(data.create_time)}`,
      tool: 'chatgpt',
      title: str(data.title),
      project: null,
      branch: null,
      startedAt: toMs(data.create_time),
      updatedAt: toMs(data.update_time),
    },
    turns,
    fallbackTime,
  );
}

/** One Claude.ai conversation: `chat_messages` from the human and the assistant. */
function claudeAiConversation(data: Json, fallbackTime: number): ImportedConversation | null {
  const turns: ImportedTurn[] = [];
  for (const message of (data.chat_messages as unknown[]).filter(isObject)) {
    const role = message.sender === 'human' ? 'user' : message.sender === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const text = Array.isArray(message.content) && message.content.length ? textParts(message.content, ['text']) : '';
    pushTurn(turns, role, text || (str(message.text) ?? ''), toMs(message.created_at));
  }
  const project = isObject(data.project) ? str(data.project.name) : null;
  return finish(
    {
      id: str(data.uuid) ?? `${toMs(data.created_at)}`,
      tool: 'claude-ai',
      title: str(data.name),
      project,
      branch: null,
      startedAt: toMs(data.created_at),
      updatedAt: toMs(data.updated_at),
    },
    turns,
    fallbackTime,
  );
}

/**
 * A `conversations.json` from a ChatGPT or Claude.ai data export, told apart by shape: ChatGPT's
 * conversations have a `mapping` of message nodes, Claude.ai's a list of `chat_messages`.
 */
export function parseExport(text: string, fallbackTime: number): ImportedConversation[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) return [];
  const out: ImportedConversation[] = [];
  for (const entry of data.filter(isObject)) {
    const conversation = isObject(entry.mapping)
      ? chatgptConversation(entry, fallbackTime)
      : Array.isArray(entry.chat_messages)
        ? claudeAiConversation(entry, fallbackTime)
        : null;
    if (conversation) out.push(conversation);
  }
  return out;
}
