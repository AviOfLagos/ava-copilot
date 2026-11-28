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
  // Messages already started or held, so one Ava Brain hands over twice (its ack lost) runs once
  seen: string[];
}

export const DEFAULT_DESKTOP_REMOTE_STATE: DesktopRemoteState = { chats: {}, pending: [], replied: {}, seen: [] };

// The most words kept waiting for a busy chat
export const PENDING_MAX = 20;
const SEEN_MAX = 200;

export interface DesktopBridgeDeps {
  inbox: () => Promise<DesktopMessage[]>;
  // Tells Ava Brain these are kept here: only then does it forget them
  ack: (ids: string[]) => Promise<void>;
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
    const incoming = await this.deps.inbox();
    const before = await this.deps.getState();
    const seen = new Set(before.seen);
    const fresh = incoming.filter(message => !seen.has(message.id));
    const queue = [...before.pending, ...fresh];
    if (queue.length) {
      const held: DesktopMessage[] = [];
      // One turn per conversation per pull: a second message for the same chat waits until it is idle
      const started = new Set<string>();
      for (const message of queue) {
        const state = await this.deps.getState();
        const threadId = state.chats[message.chatId] ?? null;
        const thread = threadId ? await this.deps.getThread(threadId).catch(() => undefined) : undefined;
        if (started.has(message.chatId) || thread?.status === 'running' || thread?.status === 'waiting_confirm') {
          held.push(message);
          continue;
        }
        started.add(message.chatId);
        try {
          const id = await this.deps.startTurn(thread ? thread.id : null, message.text);
          // Kept at once: a turn that ends before this pull does still finds its conversation
          await this.deps.updateState({ chats: { ...(await this.deps.getState()).chats, [message.chatId]: id } });
          await this.deps.reply({ chatId: message.chatId, kind: 'working', text: '' }).catch(() => {});
        } catch (error) {
          this.deps.warn('A desktop message did not start', error);
          await this.deps.reply({ chatId: message.chatId, kind: 'error', text: errorText(error) }).catch(() => {});
        }
      }
      const ids = fresh.map(message => message.id);
      await this.deps.updateState({
        pending: held.slice(-PENDING_MAX),
        seen: [...before.seen, ...ids].slice(-SEEN_MAX),
      });
    }
    if (incoming.length) await this.deps.ack(incoming.map(message => message.id));
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
      // Marked sent only once it went: a failed send goes again at the next change rather than never
      await this.deps.reply({ chatId, kind: 'answer', text: answer.content });
      const latest = await this.deps.getState();
      await this.deps.updateState({ replied: { ...latest.replied, [thread.id]: answer.seq } });
    }
    // Words held while it worked go in now
    if (state.pending.some(message => message.chatId === chatId)) await this.poll();
  }
}
