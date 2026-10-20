import { createHash } from 'node:crypto';
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
 * Ava on WhatsApp, in Nex Brain. One person only, the owner: the linked account's own "Message yourself"
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
// Her own sends show up again in the self chat; one that does within this long is not taken as the owner's
const ECHO_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;

export const AWAY_TEXT = "Your browser is closed, I'll answer when it opens.";
export const TEXT_ONLY_TEXT = 'I can only read text for now.';

interface Queued extends WhatsAppMessage {
  chatId: string;
}

interface Saved {
  version: 1;
  // A session exists to restore when Nex Brain starts
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

const hashOf = (text: string) => createHash('sha256').update(text.trim()).digest('hex').slice(0, 32);
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
  private readonly echoes = new Map<string, number>();

  constructor(private readonly deps: WhatsAppServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.limit = deps.limitPerHour ?? LIMIT_PER_HOUR;
    this.awayAfterMs = deps.awayAfterMs ?? AWAY_AFTER_MS;
    this.dir = join(deps.dataDir, 'whatsapp');
    this.file = join(this.dir, 'state.json');
    this.sessionDir = join(this.dir, 'session');
    // Until the extension pulls once, it counts as last seen when Nex Brain started
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
    };
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
    await driver?.stop().catch(() => {});
    rmSync(this.sessionDir, { recursive: true, force: true });
    this.saved = { ...EMPTY };
    this.save();
    this.qr = null;
    this.echoes.clear();
    this.setState('not_linked', null);
    return this.status();
  }

  /** The user's other number (Ava has her own), or null for the linked account's own chat only. */
  setOwner(number: string | null): WhatsAppStatus {
    const next = number && number !== this.saved.number ? number : null;
    if (next !== this.saved.ownerNumber) {
      this.saved.ownerNumber = next;
      this.saved.ownerAliases = [];
      this.save();
    }
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
    const body = text.trim().slice(0, WHATSAPP_TEXT_MAX);
    if (!body) fail('invalid', 'There is nothing to send.');
    this.saved.sentAt = [...recent, this.now()];
    this.echoes.set(`text:${hashOf(body)}`, this.now());
    this.save();
    const id = await driver.sendText(chatId, body);
    if (id) this.echoes.set(`id:${id}`, this.now());
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
    this.qr = null;
    this.setState('linked', null);
  }

  /** Keeps an owner's text message; drops everything else without keeping a trace of it. */
  async onMessage(message: WaIncoming): Promise<void> {
    const chatId = this.ownerChatFor(message);
    if (!chatId) return;
    if (this.isEcho(message)) return;
    if (this.saved.seen.includes(message.id)) return;
    this.saved.seen = [...this.saved.seen, message.id].slice(-SEEN_MAX);
    if (message.type !== 'chat') {
      this.save();
      await this.sendTo(chatId, TEXT_ONLY_TEXT).catch(() => {});
      return;
    }
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
    const owner = this.saved.ownerNumber;
    // In the owner's chat, only what the owner wrote; what Ava sent there is her own
    if (!owner || message.fromMe) return null;
    if (message.chatId === cUs(owner) || numberOfJid(message.chatId) === owner) return message.chatId;
    if (this.saved.ownerAliases.includes(message.chatId)) return message.chatId;
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
    if (this.isSelfChat(chatId)) return true;
    const owner = this.saved.ownerNumber;
    return Boolean(owner) && (chatId === cUs(owner!) || this.saved.ownerAliases.includes(chatId));
  }

  /** One of Ava's own sends coming back in the self chat. */
  private isEcho(message: WaIncoming): boolean {
    if (!message.fromMe) return false;
    const now = this.now();
    for (const [key, at] of this.echoes) if (now - at > ECHO_MS) this.echoes.delete(key);
    if (this.echoes.delete(`id:${message.id}`)) return true;
    return this.echoes.delete(`text:${hashOf(message.body)}`);
  }

  // ── Bookkeeping ──

  private defaultChat(): string | null {
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
