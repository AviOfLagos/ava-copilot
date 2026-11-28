import { randomBytes } from 'node:crypto';
import { DESKTOP_BROWSER_SEEN_MS } from '@protocol';
import type { DesktopMessage, DesktopReply, DesktopReplyKind } from '@protocol';

/**
 * The desktop app's chat, passed through Ava Brain (docs/desktop-app.md): the window's words wait here until the
 * extension takes them, and the extension's answers wait here until the window reads them. Kept in memory: a
 * restart of Ava Brain drops what was in flight and starts the answers' numbers again at 1 (the window reads
 * lastSeq and starts over when it went back).
 */

// More than this waiting, the oldest go: the window has been sending into a closed browser for a long time
export const DESKTOP_QUEUE_MAX = 50;
// The answers kept for the window to read; it reads every second or two
export const DESKTOP_REPLIES_MAX = 200;

export class DesktopChannel {
  private queue: DesktopMessage[] = [];
  private replies: DesktopReply[] = [];
  private seq = 0;
  private browserSeenAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The window's words, for the extension. */
  send(chatId: string, text: string): DesktopMessage {
    const message: DesktopMessage = { id: `dm_${randomBytes(9).toString('base64url')}`, chatId, text, at: this.now() };
    this.queue.push(message);
    if (this.queue.length > DESKTOP_QUEUE_MAX) this.queue.splice(0, this.queue.length - DESKTOP_QUEUE_MAX);
    return message;
  }

  /** Everything waiting, for the extension. It stays until the extension acks it, so nothing is lost on the way. */
  pending(): DesktopMessage[] {
    this.browserSeenAt = this.now();
    return [...this.queue];
  }

  /** The extension has kept these: forget them. */
  ack(ids: readonly string[]): void {
    const done = new Set(ids);
    this.queue = this.queue.filter(message => !done.has(message.id));
  }

  /** An answer, or a "working", from the extension. */
  reply(chatId: string, kind: DesktopReplyKind, text: string): DesktopReply {
    this.browserSeenAt = this.now();
    this.seq += 1;
    const reply: DesktopReply = { seq: this.seq, chatId, kind, text, at: this.now() };
    this.replies.push(reply);
    if (this.replies.length > DESKTOP_REPLIES_MAX) this.replies.splice(0, this.replies.length - DESKTOP_REPLIES_MAX);
    return reply;
  }

  /** The answers after the window's last one. */
  repliesAfter(after: number): DesktopReply[] {
    return this.replies.filter(reply => reply.seq > after);
  }

  /** The newest answer's number, so a window that opens late starts from now. */
  get lastSeq(): number {
    return this.seq;
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Whether the extension pulled recently: when not, the window says "open your browser". */
  browserOpen(): boolean {
    return this.browserSeenAt > 0 && this.now() - this.browserSeenAt < DESKTOP_BROWSER_SEEN_MS;
  }
}
