import type { ImportedConversation, ImportedTurn } from '../tools';
import { finish, pushTurn, textParts, toMs } from './common';

/** A reader of one JSONL session file, fed line by line so a large file never sits in memory whole. */
export interface LineReader {
  line(text: string): void;
  end(): ImportedConversation[];
}

// A line longer than this is a tool's output (a file, a screenshot): skipped without parsing
const MAX_LINE_CHARS = 2_000_000;

function parse(text: string): Record<string, unknown> | null {
  if (!text.trim() || text.length > MAX_LINE_CHARS) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The project folder of a Claude Code session when no line says it: the folder's name under
 * `projects/` is the path with "/" written as "-" (so a "-" in a real name cannot be told apart).
 */
export function claudeProjectFromPath(path: string): string | null {
  const parts = path.split('/');
  const at = parts.lastIndexOf('projects');
  const name = at >= 0 ? parts[at + 1] : parts.at(-2);
  return name?.startsWith('-') ? name.replace(/-/g, '/') : null;
}

/**
 * Claude Code: `~/.claude/projects/<project>/<session>.jsonl`. Each line is an event; user and
 * assistant lines carry `cwd`, `gitBranch`, a timestamp and an Anthropic message. Tool calls, tool
 * results and thinking are left out; `ai-title`, `summary` and `custom-title` lines name it.
 */
export function claudeCodeReader(path: string, fallbackTime: number): LineReader {
  const turns: ImportedTurn[] = [];
  let id = path
    .split('/')
    .pop()!
    .replace(/\.jsonl$/, '');
  let cwd: string | null = null;
  let branch: string | null = null;
  let title: string | null = null;
  let custom: string | null = null;
  return {
    line(text) {
      const entry = parse(text);
      if (!entry) return;
      const type = entry.type;
      if (type === 'custom-title' && typeof entry.customTitle === 'string') custom = entry.customTitle;
      if (type === 'ai-title' && typeof entry.aiTitle === 'string') title = entry.aiTitle;
      if (type === 'summary' && typeof entry.summary === 'string') title ??= entry.summary;
      if (type !== 'user' && type !== 'assistant') return;
      if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) return;
      if (typeof entry.sessionId === 'string') id = entry.sessionId;
      if (typeof entry.cwd === 'string' && !cwd) cwd = entry.cwd;
      if (typeof entry.gitBranch === 'string' && entry.gitBranch && entry.gitBranch !== 'HEAD')
        branch = entry.gitBranch;
      const message = entry.message as { content?: unknown } | undefined;
      pushTurn(turns, type, textParts(message?.content, ['text']), toMs(entry.timestamp));
    },
    end() {
      const conversation = finish(
        {
          id,
          tool: 'claude-code',
          title: custom ?? title,
          project: cwd ?? claudeProjectFromPath(path),
          branch,
          startedAt: null,
          updatedAt: null,
        },
        turns,
        fallbackTime,
      );
      return conversation ? [conversation] : [];
    },
  };
}

/**
 * OpenAI Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (and `archived_sessions`). A
 * `session_meta` line has the id, cwd and git branch; `response_item` messages hold what the user and
 * the assistant said (`input_text` / `output_text`); older files have `event_msg` user and agent
 * messages instead. Developer and system messages and tool calls are left out.
 */
export function codexReader(path: string, fallbackTime: number): LineReader {
  const turns: ImportedTurn[] = [];
  const fromEvents: ImportedTurn[] = [];
  let id = path
    .split('/')
    .pop()!
    .replace(/\.jsonl$/, '');
  let cwd: string | null = null;
  let branch: string | null = null;
  let started: number | null = null;
  return {
    line(text) {
      const entry = parse(text);
      if (!entry) return;
      const payload = (entry.payload ?? entry) as Record<string, unknown>;
      const at = toMs(entry.timestamp ?? payload.timestamp);
      if (
        entry.type === 'session_meta' ||
        (!entry.type && typeof payload.id === 'string' && 'instructions' in payload)
      ) {
        if (typeof payload.id === 'string') id = payload.id;
        if (typeof payload.cwd === 'string') cwd = payload.cwd;
        const git = payload.git as { branch?: unknown } | undefined;
        if (typeof git?.branch === 'string') branch = git.branch;
        started = toMs(payload.timestamp) ?? at;
        return;
      }
      if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
        pushTurn(turns, payload.role, textParts(payload.content), at);
        return;
      }
      if (entry.type === 'event_msg' && typeof payload.message === 'string') {
        if (payload.type === 'user_message') pushTurn(fromEvents, 'user', payload.message, at);
        if (payload.type === 'agent_message') pushTurn(fromEvents, 'assistant', payload.message, at);
      }
    },
    end() {
      const conversation = finish(
        {
          id,
          tool: 'codex',
          title: null,
          project: cwd,
          branch,
          startedAt: started,
          updatedAt: null,
        },
        turns.some(turn => turn.role === 'user') ? turns : fromEvents,
        fallbackTime,
      );
      return conversation ? [conversation] : [];
    },
  };
}
