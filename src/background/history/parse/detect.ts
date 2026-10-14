/** How a file in a picked folder is read, decided by where it sits and what it is called. */
export type FileKind =
  | { tool: 'claude-code'; format: 'claude-jsonl' }
  | { tool: 'codex'; format: 'codex-jsonl' }
  | { tool: 'gemini-cli'; format: 'gemini-json' }
  | { tool: 'vscode'; format: 'vscode-chat' }
  | { tool: 'chatgpt' | 'claude-ai'; format: 'export-json' | 'export-zip' };

// Folders that never hold a conversation, or hold another session's side work
const SKIP_FOLDERS = new Set([
  'node_modules',
  '.git',
  'subagents',
  'memory',
  'shell_snapshots',
  'file-history',
  'todos',
  'plugins',
  'cache',
  'logs',
  'debug',
  'statsig',
  'telemetry',
  'ide',
]);

/** Whether a folder is worth walking into. */
export function walkInto(name: string): boolean {
  return !SKIP_FOLDERS.has(name);
}

/**
 * The kind of a file, by its path inside the picked folder (parts joined by "/"), or null when it is
 * not a conversation. The folder may be the tool's own (`~/.claude`, `~/.codex`, `~/.gemini`), one of
 * its sub-folders, or a folder holding an export.
 */
export function classify(path: string): FileKind | null {
  const parts = path.split('/');
  const name = parts.at(-1)!.toLowerCase();
  const parent = (parts.at(-2) ?? '').toLowerCase();
  if (name.endsWith('.jsonl') && /^rollout-/.test(name)) return { tool: 'codex', format: 'codex-jsonl' };
  if (parent === 'chatsessions' && /\.jsonl?$/.test(name)) return { tool: 'vscode', format: 'vscode-chat' };
  if (name.endsWith('.jsonl')) {
    // Claude Code keeps one file per session, named by its id, in a folder per project
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(name)) {
      return { tool: 'claude-code', format: 'claude-jsonl' };
    }
    return null;
  }
  if (name.endsWith('.json')) {
    if (name === 'conversations.json') return { tool: 'chatgpt', format: 'export-json' };
    if (parent === 'chats' && /^session-/.test(name)) return { tool: 'gemini-cli', format: 'gemini-json' };
    if (parts.some(part => part === 'tmp') && (name === 'logs.json' || /^checkpoint/.test(name))) {
      return { tool: 'gemini-cli', format: 'gemini-json' };
    }
    return null;
  }
  // A data export as downloaded: read inside the zip for its conversations.json
  if (name.endsWith('.zip') && /(chatgpt|claude|openai|anthropic|export|data)/.test(name)) {
    return { tool: 'chatgpt', format: 'export-zip' };
  }
  return null;
}
