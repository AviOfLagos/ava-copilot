import type { ThreadMessage, ThreadRecord } from '@extension/storage';
import type { DesktopMessage, DesktopReplyKind } from '@src/shared/lib/protocol/companion';
import { answerOf } from '../whatsapp-remote/bridge';
import { describeRequest, plainOutside } from '../whatsapp-remote/format';

/**
 * The Ava desktop app's chat, in the background (docs/desktop-app.md, D1): pulls what the app's window sent through
 * Ava Brain, runs each conversation as a chat of its own (origin 'desktop', with every tool Ava has), and posts back
 * "working", the answer, "waits for your click" or the error. Everything it touches comes in as deps, so it is
 * tested without Chrome or Ava Brain.
 */

export interface DesktopRemoteState {
  // The app's conversation → the chat that runs it
  chats: Record<string, string>;
  // Words that came while their chat was busy: they go in when it is idle
  pending: DesktopMessage[];
  // The last answer sent from each chat (its message seq)
  replied: Record<string, number>;
}

export const DEFAULT_DESKTOP_REMOTE_STATE: DesktopRemoteState = { chats: {}, pending: [], replied: {} };

// The most words kept waiting for a busy chat
export const PENDING_MAX = 20;

export interface DesktopBridgeDeps {
  inbox: () => Promise<DesktopMessage[]>;
  reply: (request: { chatId: string; kind: DesktopReplyKind; text: string }) => Promise<void>;
  getThread: (id: string) => Promise<ThreadRecord | undefined>;
  messages: (threadId: string) => Promise<ThreadMessage[]>;
  // Starts a turn with the words, in the chat given or a new one; the chat's id
  startTurn: (threadId: string | null, text: string) => Promise<string>;
  getState: () => Promise<DesktopRemoteState>;
  updateState: (changes: Partial<DesktopRemoteState>) => Promise<unknown>;
  warn: (message: string, error?: unknown) => void;
}

const errorText = (error: unknown) => plainOutside(error instanceof Error ? error.message : String(error), 300);

export class DesktopBridge {
  private polling: Promise<void> | null = null;

  constructor(private readonly deps: DesktopBridgeDeps) {}

  /** Pulls and starts; one pull at a time. */
  poll(): Promise<void> {
    this.polling ??= this.pullOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pullOnce(): Promise<void> {
    const state = await this.deps.getState();
    const incoming = await this.deps.inbox();
    const queue = [...state.pending, ...incoming];
    if (!queue.length) return;
    const chats = { ...state.chats };
    const held: DesktopMessage[] = [];
    // One turn per conversation per pull: a second message for the same chat waits until it is idle
    const started = new Set<string>();
    for (const message of queue) {
      const threadId = chats[message.chatId] ?? null;
      const thread = threadId ? await this.deps.getThread(threadId) : undefined;
      if (started.has(message.chatId) || thread?.status === 'running' || thread?.status === 'waiting_confirm') {
        held.push(message);
        continue;
      }
      try {
        const id = await this.deps.startTurn(thread ? thread.id : null, message.text);
        chats[message.chatId] = id;
        started.add(message.chatId);
        await this.deps.reply({ chatId: message.chatId, kind: 'working', text: '' }).catch(() => {});
      } catch (error) {
        this.deps.warn('A desktop message did not start', error);
        await this.deps.reply({ chatId: message.chatId, kind: 'error', text: errorText(error) }).catch(() => {});
      }
    }
    await this.deps.updateState({ chats, pending: held.slice(-PENDING_MAX) });
  }

  /** A desktop chat changed status: its answer, its wait for a click, or its error goes to the app. */
  async onThreadUpdate(before: ThreadRecord, changes: Partial<ThreadRecord>): Promise<void> {
    if (!changes.status || changes.status === before.status) return;
    const thread = { ...before, ...changes };
    if (thread.origin !== 'desktop' || thread.status === 'running') return;
    const state = await this.deps.getState();
    const chatId = Object.entries(state.chats).find(([, threadId]) => threadId === thread.id)?.[0];
    if (!chatId) return;
    if (thread.status === 'waiting_confirm') {
      await this.deps.reply({ chatId, kind: 'needs_click', text: describeRequest(thread.pendingRequest) });
      return;
    }
    if (thread.status === 'error') {
      // Queued to try again by itself: the app hears when it is done
      if (thread.failure?.retryAt) return;
      await this.deps.reply({ chatId, kind: 'error', text: plainOutside(thread.error?.message ?? '', 300) });
      return;
    }
    if (thread.status !== 'idle') return;
    const answer = answerOf(await this.deps.messages(thread.id));
    const done = state.replied[thread.id] ?? 0;
    if (answer && answer.seq > done) {
      await this.deps.updateState({ replied: { ...state.replied, [thread.id]: answer.seq } });
      await this.deps.reply({ chatId, kind: 'answer', text: answer.content });
    }
    // Words held while it worked go in now
    if (state.pending.some(message => message.chatId === chatId)) await this.poll();
  }
}
