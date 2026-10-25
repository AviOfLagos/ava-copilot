import { createHash, randomInt } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WHATSAPP_TEXT_MAX } from '@protocol';
import type { WhatsAppMessage, WhatsAppNoticeKind, WhatsAppState, WhatsAppStatus } from '@protocol';
import { privateDir } from '../config';
import { fail } from '../errors';
import type { Logger } from '../log';
import { numberOfJid } from './driver';
import type { WaAccount, WaDriver, WaDriverFactory, WaIncoming } from './driver';

/**
 * Ava on WhatsApp, in Ava Brain. One person only, the owner: the linked account's own "Message yourself"
 * chat, and the user's other number when he set one (Ava then has a number of her own). Every message from
 * any other chat is dropped before anything about it is kept: not its text, not its id, not a log line.
 * Sending goes only to the owner; a send to any other chat is refused (sendTo). The owner's text messages
 * wait in a queue the extension pulls and acks; while it has not pulled for a while, the owner hears once
 * that the browser is closed. At most `limitPerHour` messages go out in any hour, whatever asks.
 */

export const LIMIT_PER_HOUR = 20;
// The browser counts as closed after this long without a pull
export const AWAY_AFTER_MS = 2 * 60_000;
export const QUEUE_MAX = 50;
// What the extension gets per pull
const PULL_MAX = 20;
// A queued message older than this is dropped
const QUEUE_TTL_MS = 7 * 24 * 60 * 60_000;
const SEEN_MAX = 500;
const CHATS_MAX = 200;
// Her own sends show up again in the self chat (also after a restart, or when WhatsApp syncs history): each
// is remembered by id and words this long, and carries an invisible mark besides
const ECHO_MS = 30 * 24 * 60 * 60_000;
const ECHOES_MAX = 1000;
const HOUR_MS = 60 * 60_000;
// A message dated this long before the session became ready is history being synced, not something new
const HISTORY_GRACE_MS = 60_000;

/** Invisible (two invisible separators around a zero-width space): ends every message Ava sends. */
export const OWN_MARK = '\u2063\u200b\u2063';

export const AWAY_TEXT = "Your browser is closed, I'll answer when it opens.";
export const TEXT_ONLY_TEXT = 'I can only read text for now.';
// A client may refuse to open a chat with a number this account has never talked to
export const FIRST_MESSAGE_TEXT =
  "WhatsApp won't let Ava write to your number first. Connect your phone in Settings › WhatsApp, then try again.";
export const CONNECTED_TEXT = "Connected. I'll answer you here.";
// The code the owner sends from his phone to say "this chat is mine" stays good this long
export const CONNECT_CODE_MS = 15 * 60_000;
// Letters and digits that cannot be mistaken for each other (no 0/O, 1/I/L)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
// Code-like messages from other chats while a code waits: this many and the code is thrown away
export const CONNECT_MAX_MISSES = 5;
const CODE_LIKE = /^\s*AVA-/i;
const NEW_CHAT_REFUSED = /licen[cs]e|unknown_number|new number/i;
export const FORWARDED_TEXT =
  'I only act on messages you type yourself. If you want me to look at a forwarded one, tell me in your own words.';
// Kinds that may go in quiet hours: an answer he asked for, and something waiting for his click
const ALWAYS_SENT: ReadonlySet<WhatsAppNoticeKind> = new Set(['reply', 'approval']);

interface Queued extends WhatsAppMessage {
  chatId: string;
}

interface Saved {
  version: 1;
  // A session exists to restore when Ava Brain starts
  linked: boolean;
  number: string | null;
  selfIds: string[];
  ownerNumber: string | null;
  // Ids the owner's number goes by in @lid form, learned from a message that showed the number
  ownerAliases: string[];
  queue: Queued[];
  // Owner message ids already taken (dedupe)
  seen: string[];
  sentAt: number[];
  // Where a reply to an owner message goes, after it left the queue
  chats: { id: string; chatId: string }[];
  // Her own sends, by id ("id:…") and by words ("text:<hash>"), to never take one back as the owner's
  echoes: { key: string; at: number }[];
  // No messages first in this window, kept here too so the Mac holds to it whatever the extension does
  quietStart: string;
  quietEnd: string;
  // A send to the owner was refused until he writes to Ava's number first (FIRST_MESSAGE_TEXT)
  needsFirstMessage: boolean;
  // The code he sends from his phone to make that chat his (WhatsApp may hide his number behind a @lid id)
  connectCode: { code: string; until: number; misses?: number } | null;
  // When his last message came in and Ava's last went out (times only)
  lastInAt: number | null;
  lastOutAt: number | null;
}

const EMPTY: Saved = {
  version: 1,
  linked: false,
  number: null,
  selfIds: [],
  ownerNumber: null,
  ownerAliases: [],
  queue: [],
  seen: [],
  sentAt: [],
  chats: [],
  echoes: [],
  quietStart: '22:00',
  quietEnd: '07:00',
  needsFirstMessage: false,
  connectCode: null,
  lastInAt: null,
  lastOutAt: null,
};

export interface WhatsAppServiceDeps {
  dataDir: string;
  log: Logger;
  driver: WaDriverFactory;
  findBrowser: () => string | null;
  now?: () => number;
  limitPerHour?: number;
  awayAfterMs?: number;
}

const hashOf = (text: string) =>
  createHash('sha256').update(text.replaceAll(OWN_MARK, '').trim()).digest('hex').slice(0, 32);

/** "HH:MM" to minutes since midnight, or null. */
function minutesOf(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Whether a moment is in quiet hours, which may wrap past midnight. */
export function inQuietHours(at: Date, start: string, end: string): boolean {
  const from = minutesOf(start);
  const to = minutesOf(end);
  if (from === null || to === null || from === to) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

// Seconds or milliseconds since the epoch, as milliseconds
const millisOf = (at: number) => (at > 0 && at < 1e12 ? at * 1000 : at);
const cUs = (number: string) => `${number}@c.us`;

export class WhatsAppService {
  private readonly dir: string;
  private readonly file: string;
  private readonly sessionDir: string;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly awayAfterMs: number;
  private saved: Saved = { ...EMPTY };
  private state: WhatsAppState = 'not_linked';
  private qr: string | null = null;
  private message: string | null = null;
  private driver: WaDriver | null = null;
  // Bumped on every start and stop, so events from a driver that was replaced are ignored
  private generation = 0;
  private lastPullAt: number;
  private awayNoticeSent = false;
  // When the session last became ready: anything dated well before is synced history
  private readyAt: number | null = null;

  constructor(private readonly deps: WhatsAppServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.limit = deps.limitPerHour ?? LIMIT_PER_HOUR;
    this.awayAfterMs = deps.awayAfterMs ?? AWAY_AFTER_MS;
    this.dir = join(deps.dataDir, 'whatsapp');
    this.file = join(this.dir, 'state.json');
    this.sessionDir = join(this.dir, 'session');
    // Until the extension pulls once, it counts as last seen when Ava Brain started
    this.lastPullAt = this.now();
  }

  /** Loads what was kept and, when a session was linked before, restores it in the background. */
  async init(): Promise<void> {
    privateDir(this.dir);
    try {
      if (existsSync(this.file)) this.saved = { ...EMPTY, ...JSON.parse(readFileSync(this.file, 'utf8')) };
    } catch {
      this.deps.log.warn('WhatsApp state could not be read; starting unlinked');
      this.saved = { ...EMPTY };
    }
    if (this.saved.linked) void this.link().catch(() => {});
  }

  status(): WhatsAppStatus {
    return {
      state: this.state,
      qr: this.state === 'scan' ? this.qr : null,
      number: this.state === 'linked' || this.state === 'disconnected' ? this.saved.number : null,
      ownerNumber: this.saved.ownerNumber,
      message: this.message,
      queued: this.saved.queue.length,
      sentLastHour: this.recentSends().length,
      sendLimitPerHour: this.limit,
      needsFirstMessage: this.saved.needsFirstMessage && !this.phoneConnected(),
      connectCode: this.pendingCode(),
      phoneConnected: this.phoneConnected(),
      lastInAt: this.saved.lastInAt,
      lastOutAt: this.saved.lastOutAt,
    };
  }

  /** A chat on his phone that Ava has heard from: she can always write back there. */
  private phoneConnected(): boolean {
    return this.saved.ownerAliases.length > 0;
  }

  private pendingCode(): string | null {
    const pending = this.saved.connectCode;
    return pending && pending.until > this.now() ? pending.code : null;
  }

  /**
   * A one-time code for the owner to send from his phone to Ava's number. The chat it arrives in becomes his,
   * whatever id WhatsApp shows for it (it hides numbers behind @lid ids), and Ava answers there.
   */
  startConnect(): WhatsAppStatus {
    if (this.state !== 'linked') fail('unavailable', 'WhatsApp is not linked on your Mac.');
    const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    this.saved.connectCode = { code: `AVA-${code}`, until: this.now() + CONNECT_CODE_MS, misses: 0 };
    this.save();
    return this.status();
  }

  /** Starts the session again from its saved files (no new scan), e.g. when it stopped answering. */
  async restart(): Promise<WhatsAppStatus> {
    if (!this.saved.linked) return this.link();
    this.generation++;
    const driver = this.driver;
    this.driver = null;
    await driver?.stop().catch(() => {});
    return this.link();
  }

  /** Starts the session: restores a saved one, or shows a code to scan. Does nothing while one runs. */
  async link(): Promise<WhatsAppStatus> {
    if (this.driver && ['starting', 'scan', 'linked'].includes(this.state)) return this.status();
    // A session that dropped starts over from its saved files
    await this.driver?.stop().catch(() => {});
    const generation = ++this.generation;
    const executablePath = this.deps.findBrowser();
    privateDir(this.sessionDir);
    const driver = this.deps.driver({ sessionDir: this.sessionDir, executablePath });
    this.driver = driver;
    this.setState('starting', null);
    const current = () => generation === this.generation;
    try {
      await driver.start({
        qr: code => {
          if (!current()) return;
          this.qr = code;
          this.setState('scan', null);
        },
        ready: account => current() && this.onReady(account),
        disconnected: reason => {
          if (!current()) return;
          this.setState('disconnected', reason || 'WhatsApp disconnected.');
        },
        failed: message => {
          if (!current()) return;
          this.qr = null;
          this.setState('failed', message);
          this.driver = null;
          void driver.stop().catch(() => {});
        },
        message: message => {
          if (!current()) return;
          void this.onMessage(message).catch(error =>
            this.deps.log.warn('A WhatsApp message could not be handled', { error: (error as Error).name }),
          );
        },
      });
    } catch (error) {
      if (current()) {
        this.driver = null;
        this.setState('failed', (error as Error).message?.slice(0, 300) || 'WhatsApp could not start.');
      }
      void driver.stop().catch(() => {});
    }
    return this.status();
  }

  /** Ends the session on this Mac and forgets everything: the session files, the queue, the owner. */
  async unlink(): Promise<WhatsAppStatus> {
    this.generation++;
    const driver = this.driver;
    this.driver = null;
    // Off the phone's Linked devices too, so nothing is left behind there
    await driver?.logout?.().catch(() => {});
    await driver?.stop().catch(() => {});
    rmSync(this.sessionDir, { recursive: true, force: true });
    this.saved = { ...EMPTY };
    this.save();
    this.qr = null;
    this.readyAt = null;
    this.setState('not_linked', null);
    return this.status();
  }

  /** The user's other number (Ava has her own), or null for the linked account's own chat only. */
  setOwner(number: string | null): WhatsAppStatus {
    const next = number && number !== this.saved.number ? number : null;
    if (next !== this.saved.ownerNumber) {
      this.saved.ownerNumber = next;
      this.saved.ownerAliases = [];
      this.saved.needsFirstMessage = false;
      this.saved.connectCode = null;
      // What came from a chat that is no longer the owner's goes: it must not be answered or acted on
      this.saved.queue = this.saved.queue.filter(item => this.isOwnerChat(item.chatId));
      this.saved.chats = this.saved.chats.filter(item => this.isOwnerChat(item.chatId));
      this.save();
    }
    return this.status();
  }

  /** Quiet hours: only answers and approvals go out in them. */
  setQuietHours(start: string, end: string): WhatsAppStatus {
    if (minutesOf(start) === null || minutesOf(end) === null) fail('invalid', 'Quiet hours are times like 22:00.');
    this.saved.quietStart = start;
    this.saved.quietEnd = end;
    this.save();
    return this.status();
  }

  /** The owner's messages waiting for the extension, oldest first. Pulling is how the browser says it is open. */
  pull(): WhatsAppMessage[] {
    this.lastPullAt = this.now();
    this.awayNoticeSent = false;
    this.dropExpired();
    return this.saved.queue.slice(0, PULL_MAX).map(({ id, text, at }) => ({ id, text, at }));
  }

  /** The extension took these messages into a chat. */
  ack(ids: string[]): void {
    if (!ids.length) return;
    const taken = new Set(ids);
    const before = this.saved.queue.length;
    for (const item of this.saved.queue) {
      if (taken.has(item.id)) this.saved.chats.push({ id: item.id, chatId: item.chatId });
    }
    this.saved.chats = this.saved.chats.slice(-CHATS_MAX);
    this.saved.queue = this.saved.queue.filter(item => !taken.has(item.id));
    if (this.saved.queue.length !== before) this.save();
  }

  /** Sends to the owner: to the chat `replyTo` came from, else the owner's own number, else the self chat. */
  async send(request: { text: string; kind: WhatsAppNoticeKind; replyTo?: string }): Promise<WhatsAppStatus> {
    if (
      !ALWAYS_SENT.has(request.kind) &&
      inQuietHours(new Date(this.now()), this.saved.quietStart, this.saved.quietEnd)
    ) {
      fail('forbidden', 'It is quiet hours: only answers and approvals go out now.');
    }
    const chatId = (request.replyTo && this.chatOf(request.replyTo)) || this.defaultChat();
    if (!chatId) fail('unavailable', 'WhatsApp is not linked on your Mac.');
    await this.sendTo(chatId, request.text);
    return this.status();
  }

  /**
   * The only way anything is sent. Refuses any chat that is not the owner's, whoever asks, and holds to the
   * hourly limit.
   */
  async sendTo(chatId: string, text: string): Promise<void> {
    if (!this.isOwnerChat(chatId)) fail('forbidden', 'Ava only sends WhatsApp messages to you.');
    const driver = this.driver;
    if (!driver || this.state !== 'linked') fail('unavailable', 'WhatsApp is not linked on your Mac.');
    const recent = this.recentSends();
    if (recent.length >= this.limit) {
      const retryAfterMs = recent[0] + HOUR_MS - this.now();
      fail('rate_limit', `Ava has sent ${this.limit} WhatsApp messages in the last hour.`, { retryAfterMs });
    }
    const body = text
      .replaceAll(OWN_MARK, '')
      .trim()
      .slice(0, WHATSAPP_TEXT_MAX - OWN_MARK.length);
    if (!body) fail('invalid', 'There is nothing to send.');
    this.saved.sentAt = [...recent, this.now()];
    this.remember(`text:${hashOf(body)}`);
    this.save();
    let id: unknown;
    try {
      id = await driver.sendText(chatId, `${body}${OWN_MARK}`);
    } catch (error) {
      // A send that did not go out does not count toward the hour
      this.saved.sentAt = this.saved.sentAt.slice(0, -1);
      // The client's own code and outcome only: never the text or the chat
      const { code, outcome } = (error ?? {}) as { code?: unknown; outcome?: unknown };
      this.deps.log.warn('WhatsApp send failed', {
        code: typeof code === 'string' ? code.slice(0, 40) : null,
        outcome: typeof outcome === 'string' ? outcome.slice(0, 20) : null,
        chat: chatId.split('@')[1] ?? null,
      });
      if (!this.isSelfChat(chatId) && NEW_CHAT_REFUSED.test(errorText(error))) {
        this.saved.needsFirstMessage = true;
        this.save();
        fail('forbidden', FIRST_MESSAGE_TEXT);
      }
      this.save();
      throw error;
    }
    this.saved.lastOutAt = this.now();
    if (id) this.remember(`id:${id}`);
    this.save();
  }

  async stop(): Promise<void> {
    this.generation++;
    const driver = this.driver;
    this.driver = null;
    await driver?.stop().catch(() => {});
  }

  // ── Receiving ──

  private onReady(account: WaAccount): void {
    const number = numberOfJid(account.number) ?? account.number.replace(/[^0-9]/g, '');
    // A different account than the one linked before: nothing of the old one carries over
    if (this.saved.number && this.saved.number !== number) {
      this.saved = { ...EMPTY };
    }
    this.saved.linked = true;
    this.saved.number = number || null;
    this.saved.selfIds = [...new Set([...(number ? [cUs(number)] : []), ...account.selfIds])];
    if (this.saved.ownerNumber === number) this.saved.ownerNumber = null;
    this.save();
    this.readyAt = this.now();
    this.qr = null;
    this.setState('linked', null);
  }

  /** Keeps an owner's text message; drops everything else without keeping a trace of it. */
  async onMessage(message: WaIncoming): Promise<void> {
    if (await this.connectFrom(message)) return;
    const chatId = this.ownerChatFor(message);
    if (!chatId) return;
    if (this.isEcho(message)) return;
    // History synced at link or after a restart is not something he just said
    const at = millisOf(message.at);
    if (this.readyAt === null || !(at > 0) || at < this.readyAt - HISTORY_GRACE_MS) return;
    if (this.saved.seen.includes(message.id)) return;
    this.saved.seen = [...this.saved.seen, message.id].slice(-SEEN_MAX);
    if (message.type !== 'chat') {
      this.save();
      await this.sendTo(chatId, TEXT_ONLY_TEXT).catch(() => {});
      return;
    }
    // Someone else's words he passed on are never taken as his instructions
    if (message.forwarded) {
      this.save();
      await this.sendTo(chatId, FORWARDED_TEXT).catch(() => {});
      return;
    }
    // He wrote to Ava's number, so the chat exists and her sends to him go through now
    if (!this.isSelfChat(chatId)) {
      this.saved.needsFirstMessage = false;
      this.learnChat(chatId);
    }
    this.saved.lastInAt = this.now();
    const text = message.body.trim().slice(0, WHATSAPP_TEXT_MAX);
    if (!text) {
      this.save();
      return;
    }
    this.dropExpired();
    this.saved.queue = [...this.saved.queue, { id: message.id, text, at: this.now(), chatId }].slice(-QUEUE_MAX);
    this.save();
    if (this.now() - this.lastPullAt > this.awayAfterMs && !this.awayNoticeSent) {
      this.awayNoticeSent = true;
      await this.sendTo(chatId, AWAY_TEXT).catch(() => {});
    }
  }

  /** The owner chat a message is in, or null when it is anyone else's (and must be dropped). */
  private ownerChatFor(message: WaIncoming): string | null {
    if (message.isGroup || /@(g\.us|broadcast|newsletter)$/.test(message.chatId)) return null;
    if (this.isSelfChat(message.chatId)) return message.fromMe ? message.chatId : null;
    // In the owner's chat, only what the owner wrote; what Ava sent there is her own
    if (message.fromMe) return null;
    if (this.saved.ownerAliases.includes(message.chatId)) return message.chatId;
    const owner = this.saved.ownerNumber;
    if (!owner) return null;
    if (message.chatId === cUs(owner) || numberOfJid(message.chatId) === owner) return message.chatId;
    // A chat in @lid form is the owner's only when the message shows his number
    if (message.chatId.endsWith('@lid') && message.senderNumber === owner) {
      this.saved.ownerAliases = [...this.saved.ownerAliases, message.chatId].slice(-5);
      return message.chatId;
    }
    return null;
  }

  private isSelfChat(chatId: string): boolean {
    return Boolean(this.saved.number) && (this.saved.selfIds.includes(chatId) || chatId === cUs(this.saved.number!));
  }

  private isOwnerChat(chatId: string): boolean {
    if (this.isSelfChat(chatId) || this.saved.ownerAliases.includes(chatId)) return true;
    const owner = this.saved.ownerNumber;
    return Boolean(owner) && chatId === cUs(owner!);
  }

  /** Keeps a chat of his that Ava heard from, newest last. */
  private learnChat(chatId: string): void {
    this.saved.ownerAliases = [...this.saved.ownerAliases.filter(id => id !== chatId), chatId].slice(-5);
  }

  /**
   * His connect code, sent from his phone: that chat becomes his, and Ava says so there. The message must be the
   * code and nothing else (no list of guesses), typed rather than forwarded, from his number when WhatsApp shows
   * one; a few wrong code-like messages and the code is gone, so it cannot be guessed.
   */
  private async connectFrom(message: WaIncoming): Promise<boolean> {
    const code = this.pendingCode();
    if (!code || message.fromMe || message.isGroup || message.type !== 'chat') return false;
    if (/@(g\.us|broadcast|newsletter)$/.test(message.chatId) || this.isSelfChat(message.chatId)) return false;
    if (!CODE_LIKE.test(message.body)) return false;
    const owner = this.saved.ownerNumber;
    const wrongSender = Boolean(owner && message.senderNumber && message.senderNumber !== owner);
    if (message.body.trim().toUpperCase() !== code || message.forwarded || wrongSender) {
      const pending = this.saved.connectCode!;
      pending.misses = (pending.misses ?? 0) + 1;
      if (pending.misses >= CONNECT_MAX_MISSES) {
        this.saved.connectCode = null;
        this.deps.log.warn('WhatsApp connect code thrown away after wrong tries');
      }
      this.save();
      return true;
    }
    // A code in synced history is not him sending it now
    const at = millisOf(message.at);
    if (this.readyAt === null || !(at > 0) || at < this.readyAt - HISTORY_GRACE_MS) return false;
    this.saved.connectCode = null;
    this.saved.needsFirstMessage = false;
    this.saved.lastInAt = this.now();
    this.saved.seen = [...this.saved.seen, message.id].slice(-SEEN_MAX);
    this.learnChat(message.chatId);
    this.save();
    this.deps.log.info('WhatsApp phone connected');
    await this.sendTo(message.chatId, CONNECTED_TEXT).catch(() => {});
    return true;
  }

  /** One of Ava's own sends coming back in the self chat: her mark, her id, or her words. */
  private isEcho(message: WaIncoming): boolean {
    if (!message.fromMe) return false;
    if (message.body.includes(OWN_MARK)) return true;
    const since = this.now() - ECHO_MS;
    const keys = new Set(this.saved.echoes.filter(item => item.at > since).map(item => item.key));
    return keys.has(`id:${message.id}`) || keys.has(`text:${hashOf(message.body)}`);
  }

  private remember(key: string): void {
    const since = this.now() - ECHO_MS;
    this.saved.echoes = [
      ...this.saved.echoes.filter(item => item.at > since && item.key !== key),
      { key, at: this.now() },
    ].slice(-ECHOES_MAX);
  }

  // ── Bookkeeping ──

  private defaultChat(): string | null {
    // A chat he wrote from exists for sure; his number's own id may not yet
    const known = this.saved.ownerAliases.at(-1);
    if (known) return known;
    if (this.saved.ownerNumber) return cUs(this.saved.ownerNumber);
    return this.saved.number ? cUs(this.saved.number) : null;
  }

  private chatOf(messageId: string): string | null {
    return (
      this.saved.queue.find(item => item.id === messageId)?.chatId ??
      this.saved.chats.find(item => item.id === messageId)?.chatId ??
      null
    );
  }

  private recentSends(): number[] {
    const since = this.now() - HOUR_MS;
    return this.saved.sentAt.filter(at => at > since);
  }

  private dropExpired(): void {
    const since = this.now() - QUEUE_TTL_MS;
    const kept = this.saved.queue.filter(item => item.at > since);
    if (kept.length !== this.saved.queue.length) {
      this.saved.queue = kept;
      this.save();
    }
  }

  private setState(state: WhatsAppState, message: string | null): void {
    if (state !== this.state) this.deps.log.info('WhatsApp', { state });
    this.state = state;
    this.message = message;
  }

  private save(): void {
    privateDir(this.dir);
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.saved), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

/** An error's code and words, whatever shape the driver threw it in. */
function errorText(error: unknown): string {
  if (error instanceof Error) return `${(error as { code?: unknown }).code ?? ''} ${error.message}`;
  return typeof error === 'string' ? error : JSON.stringify(error ?? '');
}
