import type { ImportedConversation, ImportedTurn } from '../tools';

// The most of one turn that is kept: a pasted log or a long answer is cut, not dropped
export const MAX_TURN_CHARS = 4000;
// The most of one conversation that is kept: its opening and its latest turns
export const MAX_CONVERSATION_CHARS = 40_000;
const MAX_TITLE_CHARS = 120;

// Wrappers tools put around what was not typed by the user: reminders, command output, IDE context
const WRAPPED =
  /<(system-reminder|local-command-stdout|local-command-stderr|command-name|command-message|command-args|environment_context|user_instructions|ide_selection|ide_opened_file|task-notification)>[\s\S]*?<\/\1>/g;

/** A turn's text without the wrappers tools add, trimmed and cut to size. */
export function cleanText(text: string): string {
  const flat = text
    .replace(WRAPPED, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return flat.length > MAX_TURN_CHARS ? `${flat.slice(0, MAX_TURN_CHARS - 1)}…` : flat;
}

/** Whether a user turn is the tool talking, not the person: meta lines, interrupted requests, caveats. */
export function isNoise(text: string): boolean {
  return (
    !text ||
    /^\[Request interrupted/.test(text) ||
    /^Caveat: The messages below were generated/.test(text) ||
    /^<[a-z_-]+>/.test(text)
  );
}

/** A title from the first thing the user said, on one line. */
export function titleFrom(text: string | undefined, fallback: string): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
  return line || fallback;
}

/** A timestamp in milliseconds from what tools write: ISO strings, seconds or milliseconds. */
export function toMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Adds a turn, joining it to the last one when the same side speaks again (an assistant's text split
 * around its tool calls reads as one answer).
 */
export function pushTurn(turns: ImportedTurn[], role: ImportedTurn['role'], text: string, at: number | null): void {
  const clean = cleanText(text);
  if (!clean || (role === 'user' && isNoise(clean))) return;
  const last = turns.at(-1);
  if (last && last.role === role) {
    last.text = cleanText(`${last.text}\n\n${clean}`);
    // The turn's time is when it last went on
    last.at = at ?? last.at;
    return;
  }
  turns.push({ role, text: clean, at });
}

/**
 * Keeps a conversation within its size: the first exchange (what it was about) and as many of the
 * latest turns as fit (where it got to). A marker says turns were left out.
 */
export function capTurns(turns: ImportedTurn[], max = MAX_CONVERSATION_CHARS): ImportedTurn[] {
  const total = turns.reduce((sum, turn) => sum + turn.text.length, 0);
  if (total <= max) return turns;
  const head = turns.slice(0, 2);
  let budget = max - head.reduce((sum, turn) => sum + turn.text.length, 0);
  const tail: ImportedTurn[] = [];
  for (let at = turns.length - 1; at >= head.length && budget > 0; at--) {
    if (turns[at].text.length > budget) break;
    budget -= turns[at].text.length;
    tail.unshift(turns[at]);
  }
  const left = turns.length - head.length - tail.length;
  return left > 0
    ? [...head, { role: 'assistant', text: `(${left} turns left out)`, at: null }, ...tail]
    : [...head, ...tail];
}

/** A finished conversation, or null when nobody said anything worth keeping. */
export function finish(
  conversation: Omit<ImportedConversation, 'turns' | 'startedAt' | 'updatedAt' | 'title'> & {
    title: string | null;
    startedAt: number | null;
    updatedAt: number | null;
  },
  turns: ImportedTurn[],
  fallbackTime: number,
): ImportedConversation | null {
  if (!turns.some(turn => turn.role === 'user')) return null;
  const times = turns.map(turn => turn.at).filter((at): at is number => at !== null);
  const startedAt = conversation.startedAt ?? (times.length ? Math.min(...times) : fallbackTime);
  const updatedAt = conversation.updatedAt ?? (times.length ? Math.max(...times) : startedAt);
  return {
    ...conversation,
    title:
      titleFrom(conversation.title ?? undefined, '') || titleFrom(turns.find(t => t.role === 'user')?.text, 'Untitled'),
    startedAt,
    updatedAt: Math.max(updatedAt, startedAt),
    turns: capTurns(turns),
  };
}

/** The text parts of a message's content, whatever shape the tool gave it. */
export function textParts(content: unknown, types = ['text', 'input_text', 'output_text']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && types.includes((part as { type?: string }).type ?? 'text')) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
