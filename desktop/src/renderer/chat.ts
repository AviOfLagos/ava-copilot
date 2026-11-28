import type { DesktopReply } from '@protocol';

/**
 * The window's conversation, as plain data: what the owner sent, Ava's answers, and short notes ("waits for your
 * click in the browser"). Pure, so it is tested without a window.
 */

export type ChatLine =
  | { id: string; role: 'you'; text: string; at: number; failed?: string }
  | { id: string; role: 'ava'; text: string; at: number }
  | { id: string; role: 'note'; tone: 'hold' | 'error' | 'info'; text: string; at: number };

export interface ChatState {
  chatId: string;
  lines: ChatLine[];
  // The chat is working on something
  working: boolean;
  // The newest answer read from Ava Brain
  seq: number;
}

// The most lines a window keeps
export const LINES_MAX = 300;

/** A conversation id Ava Brain takes (dc_ and lowercase letters and digits). */
export function newChatId(random: () => number = Math.random): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) id += letters[Math.floor(random() * letters.length)];
  return `dc_${id}`;
}

export function emptyChat(chatId: string, seq = 0): ChatState {
  return { chatId, lines: [], working: false, seq };
}

const keep = (lines: ChatLine[]) => lines.slice(-LINES_MAX);

/** The owner's words, shown at once. */
export function addSent(state: ChatState, text: string, at: number, id: string): ChatState {
  return { ...state, working: true, lines: keep([...state.lines, { id, role: 'you', text, at }]) };
}

/** Ava Brain did not take a message: it stays, marked, with why. */
export function markFailed(state: ChatState, id: string, why: string): ChatState {
  return {
    ...state,
    working: false,
    lines: state.lines.map(line => (line.id === id && line.role === 'you' ? { ...line, failed: why } : line)),
  };
}

/** What the extension sent back for this conversation; others are left for their own window. */
export function applyReplies(state: ChatState, replies: DesktopReply[]): ChatState {
  let next = state;
  for (const reply of replies) {
    if (reply.seq <= next.seq) continue;
    next = { ...next, seq: reply.seq };
    if (reply.chatId !== state.chatId) continue;
    const id = `r${reply.seq}`;
    switch (reply.kind) {
      case 'working':
        next = { ...next, working: true };
        break;
      case 'answer':
        next = {
          ...next,
          working: false,
          lines: keep([...next.lines, { id, role: 'ava', text: reply.text, at: reply.at }]),
        };
        break;
      case 'needs_click':
        next = {
          ...next,
          working: false,
          lines: keep([
            ...next.lines,
            {
              id,
              role: 'note',
              tone: 'hold',
              text: `Waiting for your click in the browser's Ava panel${reply.text ? `: ${reply.text}` : ''}.`,
              at: reply.at,
            },
          ]),
        };
        break;
      case 'error':
        next = {
          ...next,
          working: false,
          lines: keep([
            ...next.lines,
            { id, role: 'note', tone: 'error', text: reply.text || 'The chat stopped.', at: reply.at },
          ]),
        };
        break;
    }
  }
  return next;
}

/** The chat kept between launches, repaired when it is not what this version writes. */
export function restoreChat(saved: unknown, fallbackId: string): ChatState {
  const raw = saved && typeof saved === 'object' ? (saved as Partial<ChatState>) : {};
  const chatId = typeof raw.chatId === 'string' && /^dc_[a-z0-9]{8,40}$/.test(raw.chatId) ? raw.chatId : fallbackId;
  const lines = Array.isArray(raw.lines)
    ? raw.lines.filter(
        (line): line is ChatLine =>
          Boolean(line) &&
          typeof line.id === 'string' &&
          typeof line.text === 'string' &&
          typeof line.role === 'string',
      )
    : [];
  // A restart forgets what was working: Ava Brain's answers are read again from where it is now
  return { chatId, lines: keep(lines), working: false, seq: 0 };
}
