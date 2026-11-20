import { createHash, randomInt } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WHATSAPP_MEDIA_MAX_BYTES, WHATSAPP_TEXT_MAX, WHATSAPP_VOICE_MAX_BYTES } from '@protocol';
import type {
  WhatsAppLink,
  WhatsAppMediaKind,
  WhatsAppMediaReply,
  WhatsAppMediaRequest,
  WhatsAppMessage,
  WhatsAppNoticeKind,
  WhatsAppPresenceRequest,
  WhatsAppReactRequest,
  WhatsAppReviseRequest,
  WhatsAppState,
  WhatsAppStatus,
  WhatsAppVoiceRequest,
} from '@protocol';
import { privateDir } from '../config';
import { fail } from '../errors';
import type { Logger } from '../log';
import { runProcess } from '../sandbox/process';
import type { ProcessRunner } from '../sandbox/process';
import { documentText } from './documents';
import { numberOfJid } from './driver';
import type { WaAccount, WaDriver, WaDriverFactory, WaIncoming, WaQuote, WaRef } from './driver';

/**
 * Ava on WhatsApp, in Ava Brain. One person only, the owner: the linked account's own "Message yourself"
 * chat, and the user's other number when he set one (Ava then has a number of her own). Every message from
 * any other chat is dropped before anything about it is kept: not its text, not its id, not a log line.
 * Sending goes only to the owner; a send to any other chat is refused (sendTo). The owner's messages (words,
 * links, voice notes, pictures, documents) wait in a queue the extension pulls and acks: a voice note's or
 * picture's file waits beside it until the ack, and a document is kept in whatsapp/files. Video, stickers,
 * locations and contacts get a plain answer and are not kept. While the extension has not pulled for a while,
 * the owner hears once that the browser is closed. At most `limitPerHour` messages go out in any hour,
 * whatever asks. No file name, caption or file content is ever logged.
 *
 * Ava answers like a person: "typing…" or "recording…" while she works (not in the self chat, where WhatsApp shows
 * neither), a voice note the extension made, a quote of the message she answers, reactions on his messages, and her
 * own last message edited or deleted when he says so. All of it goes only to the owner's chats; voice notes, edits
 * and deletes count toward the hour, reactions have an hourly limit of their own.
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
// What he sent while the line was down (the Mac asleep, a dropped connection) still gets an answer when it comes
// back, unless it is older than this: a stale instruction is not carried out hours later
export const OFFLINE_MAX_MS = 12 * HOUR_MS;
export const REACTIONS_PER_HOUR = 60;
// WhatsApp lets a message be edited this long after it was sent, and deleted for everyone about this long
export const EDIT_WINDOW_MS = 15 * 60_000;
export const DELETE_WINDOW_MS = 48 * HOUR_MS;
// Her own sends kept by id (ids and times only), for "delete that" and reactions on them
const OWN_MAX = 20;
// His recent messages' words kept in memory only, never on disk, to quote them above an answer
const QUOTABLE_MAX = 100;

/** Invisible (two invisible separators around a zero-width space): ends every message Ava sends. */
export const OWN_MARK = '\u2063\u200b\u2063';

export const AWAY_TEXT = "Your browser is closed, I'll answer when it opens.";
// Something WhatsApp sent that Ava has no reading for at all
export const TEXT_ONLY_TEXT = 'I can only read words, voice notes, photos, documents and links for now.';
// What she has no use for yet: said in plain words, and nothing of it kept
export const NOT_YET_TEXT: Record<string, string> = {
  video: "I got your video, but I can't watch videos yet. Tell me in words what you need, or send a photo.",
  sticker: 'I got your sticker. I can only read words, voice notes, photos, documents and links for now.',
  location:
    "I got your location, but I can't use locations yet. Type the address if you want me to do something with it.",
  contact:
    "I got the contact, but I can't read contact cards yet. Type the name and number if you want me to use them.",
};
export const DOWNLOAD_FAILED_TEXT = "I couldn't download that from WhatsApp. Try sending it again.";
const NOUNS: Record<WhatsAppMediaKind, string> = { voice: 'voice note', image: 'photo', document: 'file' };
const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
export const tooBigText = (kind: WhatsAppMediaKind, size: number) =>
  `That ${NOUNS[kind]} is ${megabytes(size)}; I can take up to ${megabytes(WHATSAPP_MEDIA_MAX_BYTES[kind])}.`;
// Kept documents beyond this much in all: the oldest go
export const FILES_MAX_BYTES = 1024 * 1024 * 1024;
// A link typed without WhatsApp's preview
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"']+/i;
// The kind of file each WhatsApp message type is to Ava
const MEDIA_KINDS: Record<string, WhatsAppMediaKind> = { audio: 'voice', image: 'image', document: 'document' };
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
export const NOTHING_TO_CHANGE_TEXT = 'There is no message of mine to change.';
export const NOT_MINE_TEXT = 'I can only change my own messages.';
export const EDIT_TOO_LATE_TEXT = 'WhatsApp only lets a message be edited for 15 minutes after it was sent.';
export const DELETE_TOO_LATE_TEXT = 'That message is too old for WhatsApp to delete for everyone.';
export const EDIT_VOICE_TEXT = 'A voice note can\'t be edited; say "delete that" and I\'ll send a new one.';
// Kinds that may go in quiet hours: an answer he asked for, and something waiting for his click
const ALWAYS_SENT: ReadonlySet<WhatsAppNoticeKind> = new Set(['reply', 'approval']);

interface Queued extends WhatsAppMessage {
  chatId: string;
  // Where a document is kept on the Mac
  savedAs?: string | null;
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
  // Her own sends, newest last: ids, chats and times only
  own: { id: string; chatId: string; at: number; kind: 'text' | 'voice' }[];
  reactedAt: number[];
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
  own: [],
  reactedAt: [],
};

export interface WhatsAppServiceDeps {
  dataDir: string;
  log: Logger;
  driver: WaDriverFactory;
  findBrowser: () => string | null;
  now?: () => number;
  limitPerHour?: number;
  awayAfterMs?: number;
  // Runs the Mac's own tools that read a document (see ./documents.ts)
  run?: ProcessRunner;
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
  // A queued voice note's or picture's file, until the ack
  private readonly mediaDir: string;
  // Documents he sent, kept on the Mac
  private readonly filesDir: string;
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
  // When this session first became ready: anything dated well before is synced history. Reconnects keep it, so
  // what arrived while the line was down is still new
  private readyAt: number | null = null;
  // His recent messages, to quote above an answer: in memory only, gone on a restart (the answer is then unquoted)
  private readonly quotable = new Map<string, { text: string; voiceSeconds: number | null }>();

  constructor(private readonly deps: WhatsAppServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.limit = deps.limitPerHour ?? LIMIT_PER_HOUR;
    this.awayAfterMs = deps.awayAfterMs ?? AWAY_AFTER_MS;
    this.dir = join(deps.dataDir, 'whatsapp');
    this.file = join(this.dir, 'state.json');
    this.sessionDir = join(this.dir, 'session');
    this.mediaDir = join(this.dir, 'media');
    this.filesDir = join(this.dir, 'files');
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
    this.readyAt = null;
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
    // Files waiting in the queue go with it; documents already kept stay his
    rmSync(this.mediaDir, { recursive: true, force: true });
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
      this.dropMedia(this.saved.queue.filter(item => !this.isOwnerChat(item.chatId)));
      this.saved.queue = this.saved.queue.filter(item => this.isOwnerChat(item.chatId));
      this.saved.chats = this.saved.chats.filter(item => this.isOwnerChat(item.chatId));
      this.saved.own = this.saved.own.filter(item => this.isOwnerChat(item.chatId));
      this.quotable.clear();
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
    return this.saved.queue.slice(0, PULL_MAX).map(({ id, text, at, kind, media, link, quotedId }) => ({
      id,
      text,
      at,
      kind: kind ?? 'text',
      media: media ?? null,
      link: link ?? null,
      quotedId: quotedId ?? null,
    }));
  }

  /**
   * A queued message's file for the extension: a voice note or picture as its bytes, a document as its text (read
   * on the Mac). Only while the message waits in the queue, which holds the owner's messages alone.
   */
  async media(request: WhatsAppMediaRequest): Promise<WhatsAppMediaReply> {
    const item = this.saved.queue.find(queued => queued.id === request.id);
    if (!item?.media) fail('not_found', 'That message has no file waiting.');
    const { mediaType, size, name } = item.media;
    if (request.as === 'text') {
      if (item.kind !== 'document' || !item.savedAs) fail('invalid', 'Only a document is read as text.');
      const read = await documentText(item.savedAs, name, mediaType, { run: this.deps.run ?? runProcess }).catch(
        () => ({ text: null, truncated: false }),
      );
      return {
        ok: true,
        mediaType,
        size,
        data: null,
        text: read.text,
        truncated: read.truncated,
        savedAs: item.savedAs,
      };
    }
    if (item.kind === 'document') fail('invalid', 'A document is read as text.');
    const bytes = await readFile(this.mediaFile(item.id)).catch(() => null);
    if (!bytes) fail('not_found', 'That file is no longer on the Mac.');
    return { ok: true, mediaType, size, data: bytes.toString('base64'), text: null, truncated: false, savedAs: null };
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
    this.dropMedia(this.saved.queue.filter(item => taken.has(item.id)));
    this.saved.queue = this.saved.queue.filter(item => !taken.has(item.id));
    if (this.saved.queue.length !== before) this.save();
  }

  /** Sends to the owner: to the chat `replyTo` came from, else the owner's own number, else the self chat. */
  async send(request: {
    text: string;
    kind: WhatsAppNoticeKind;
    replyTo?: string;
    quote?: boolean;
  }): Promise<WhatsAppStatus> {
    const chatId = this.answerChat(request);
    await this.sendTo(chatId, request.text, { quote: this.quoteOf(request, chatId) });
    return this.status();
  }

  /** A voice note the extension made (Ogg/Opus), to the same chat an answer in words would go to. */
  async sendVoice(request: Omit<WhatsAppVoiceRequest, 'requestId'>): Promise<WhatsAppStatus> {
    const chatId = this.answerChat(request);
    const driver = this.ready(chatId);
    if (!driver.sendVoice) fail('unavailable', 'This WhatsApp client cannot send voice notes.');
    const audio = Buffer.from(request.audio, 'base64');
    if (audio.length > WHATSAPP_VOICE_MAX_BYTES) fail('invalid', 'That voice note is too long to send.');
    if (!isOggOpus(audio)) fail('invalid', 'A voice note must be Ogg/Opus.');
    const quote = this.quoteOf(request, chatId);
    await this.deliver(chatId, 'voice', () =>
      driver.sendVoice!(chatId, { audio, seconds: request.seconds, waveform: request.waveform }, { quote }),
    );
    return this.status();
  }

  /**
   * Shows "typing…" or "recording…" in the chat an answer goes to, or stops. Not in the self chat (WhatsApp shows it
   * to no one there), and never to any chat but his.
   */
  async presence(request: WhatsAppPresenceRequest): Promise<WhatsAppStatus> {
    const chatId = (request.replyTo && this.chatOf(request.replyTo)) || this.defaultChat();
    if (!chatId || this.isSelfChat(chatId)) return this.status();
    if (!this.isOwnerChat(chatId)) fail('forbidden', 'Ava only sends WhatsApp messages to you.');
    const driver = this.driver;
    if (!driver?.presence || this.state !== 'linked') return this.status();
    await driver
      .presence(chatId, request.state)
      .catch(error => this.deps.log.warn('WhatsApp presence failed', { error: (error as Error).name }));
    return this.status();
  }

  /**
   * A reaction on one of his messages or one of hers (by id), or on her own last message. Only in his chats; at most
   * REACTIONS_PER_HOUR in any hour.
   */
  async react(request: Omit<WhatsAppReactRequest, 'requestId'>): Promise<WhatsAppStatus> {
    const target = this.refOf(request.messageId);
    if (!target) fail('not_found', NOTHING_TO_CHANGE_TEXT);
    if (!this.isOwnerChat(target.chatId)) fail('forbidden', 'Ava only sends WhatsApp messages to you.');
    const driver = this.driver;
    if (!driver?.react || this.state !== 'linked') fail('unavailable', 'WhatsApp is not linked on your Mac.');
    const since = this.now() - HOUR_MS;
    const recent = this.saved.reactedAt.filter(at => at > since);
    if (recent.length >= REACTIONS_PER_HOUR) {
      fail('rate_limit', `Ava has reacted ${REACTIONS_PER_HOUR} times in the last hour.`, {
        retryAfterMs: recent[0] + HOUR_MS - this.now(),
      });
    }
    await driver.react(target, request.emoji);
    this.saved.reactedAt = [...recent, this.now()];
    this.save();
    return this.status();
  }

  /**
   * Her own last message (or the one of hers he quoted) edited, words only and within 15 minutes, or deleted for
   * everyone, when he says so.
   */
  async revise(request: Omit<WhatsAppReviseRequest, 'requestId'>): Promise<WhatsAppStatus> {
    const last = request.messageId ? this.saved.own.find(item => item.id === request.messageId) : this.saved.own.at(-1);
    if (!last) fail('not_found', request.messageId ? NOT_MINE_TEXT : NOTHING_TO_CHANGE_TEXT);
    const driver = this.ready(last.chatId);
    const ref: WaRef = { chatId: last.chatId, id: last.id, fromMe: true };
    const age = this.now() - last.at;
    if (request.action === 'delete') {
      if (age > DELETE_WINDOW_MS) fail('invalid', DELETE_TOO_LATE_TEXT);
      if (!driver.remove) fail('unavailable', 'This WhatsApp client cannot delete messages.');
      await this.deliver(last.chatId, null, async () => {
        await driver.remove!(ref);
        return null;
      });
      this.saved.own = this.saved.own.filter(item => item.id !== last.id);
      this.save();
      return this.status();
    }
    if (last.kind !== 'text') fail('invalid', EDIT_VOICE_TEXT);
    if (age > EDIT_WINDOW_MS) fail('invalid', EDIT_TOO_LATE_TEXT);
    if (!driver.edit) fail('unavailable', 'This WhatsApp client cannot edit messages.');
    const body = bodyOf(request.text ?? '');
    if (!body) fail('invalid', 'There is nothing to send.');
    this.remember(`text:${hashOf(body)}`);
    await this.deliver(last.chatId, null, async () => {
      await driver.edit!(ref, `${body}${OWN_MARK}`);
      return null;
    });
    return this.status();
  }

  /**
   * The only way words are sent. Refuses any chat that is not the owner's, whoever asks, and holds to the
   * hourly limit.
   */
  async sendTo(chatId: string, text: string, options: { quote?: WaQuote } = {}): Promise<void> {
    const driver = this.ready(chatId);
    const body = bodyOf(text);
    if (!body) fail('invalid', 'There is nothing to send.');
    this.remember(`text:${hashOf(body)}`);
    await this.deliver(chatId, 'text', () => driver.sendText(chatId, `${body}${OWN_MARK}`, options));
  }

  /** The driver, when a send to this chat may go now: his chat only, linked, and under the hourly limit. */
  private ready(chatId: string): WaDriver {
    if (!this.isOwnerChat(chatId)) fail('forbidden', 'Ava only sends WhatsApp messages to you.');
    const driver = this.driver;
    if (!driver || this.state !== 'linked') fail('unavailable', 'WhatsApp is not linked on your Mac.');
    const recent = this.recentSends();
    if (recent.length >= this.limit) {
      const retryAfterMs = recent[0] + HOUR_MS - this.now();
      fail('rate_limit', `Ava has sent ${this.limit} WhatsApp messages in the last hour.`, { retryAfterMs });
    }
    return driver;
  }

  /**
   * Sends one thing that counts toward the hour (checked by `ready` first) and keeps its id as her own, so it is
   * never taken back as his and "delete that" finds it. `kind` null: an edit or delete, kept as nothing new.
   */
  private async deliver(
    chatId: string,
    kind: 'text' | 'voice' | null,
    attempt: () => Promise<string | null>,
  ): Promise<void> {
    this.saved.sentAt = [...this.recentSends(), this.now()];
    this.save();
    let id: unknown;
    try {
      id = await attempt();
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
    if (typeof id === 'string' && id) {
      this.remember(`id:${id}`);
      if (kind) this.saved.own = [...this.saved.own, { id, chatId, at: this.now(), kind }].slice(-OWN_MAX);
    }
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
    this.readyAt ??= this.now();
    this.qr = null;
    this.setState('linked', null);
  }

  /** Keeps an owner's message (and its file); drops everything else without keeping a trace of it. */
  async onMessage(message: WaIncoming): Promise<void> {
    // WhatsApp's own bookkeeping (key shares, settings, receipts): never something he said, never answered
    if (message.type === 'system') return;
    if (await this.connectFrom(message)) return;
    const chatId = this.ownerChatFor(message);
    if (!chatId) return;
    if (this.isEcho(message)) return;
    // History synced at link or after a restart is not something he just said
    const at = millisOf(message.at);
    if (!this.isNew(at)) return;
    if (this.saved.seen.includes(message.id)) return;
    this.saved.seen = [...this.saved.seen, message.id].slice(-SEEN_MAX);
    // Someone else's words, voice or files he passed on are never taken as his instructions
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
    this.save();
    const item = await this.itemOf(message, chatId);
    if (!item) return;
    this.quotable.set(item.id, {
      text: item.text,
      voiceSeconds: item.kind === 'voice' ? Math.round(item.media?.seconds ?? 0) : null,
    });
    while (this.quotable.size > QUOTABLE_MAX) this.quotable.delete(this.quotable.keys().next().value!);
    this.dropExpired();
    const queue = [...this.saved.queue, item];
    this.dropMedia(queue.slice(0, -QUEUE_MAX));
    this.saved.queue = queue.slice(-QUEUE_MAX);
    this.save();
    if (this.now() - this.lastPullAt > this.awayAfterMs && !this.awayNoticeSent) {
      this.awayNoticeSent = true;
      await this.sendTo(chatId, AWAY_TEXT).catch(() => {});
    }
  }

  /**
   * What goes in the queue for an owner's message: his words (a link marked as one), or a voice note, picture or
   * document with its caption, its file fetched and capped. Anything else gets a plain answer here, and null.
   */
  private async itemOf(message: WaIncoming, chatId: string): Promise<Queued | null> {
    const text = message.body.trim().slice(0, WHATSAPP_TEXT_MAX);
    const base = { id: message.id, text, at: this.now(), chatId, media: null, link: null };
    const quotedId = message.quotedId ?? null;
    if (message.type === 'chat') {
      if (!text) return null;
      const link = message.link ? cleanLink(message.link) : linkInText(text);
      return { ...base, kind: link ? 'link' : 'text', link, quotedId };
    }
    const reply = async (words: string) => {
      await this.sendTo(chatId, words).catch(() => {});
      return null;
    };
    const kind = MEDIA_KINDS[message.type];
    if (!kind) return reply(NOT_YET_TEXT[message.type] ?? TEXT_ONLY_TEXT);
    const info = message.media;
    const cap = WHATSAPP_MEDIA_MAX_BYTES[kind];
    if (info?.size && info.size > cap) return reply(tooBigText(kind, info.size));
    if (!message.download) return reply(DOWNLOAD_FAILED_TEXT);
    let bytes: Buffer;
    try {
      bytes = await message.download(cap);
    } catch (error) {
      // The reason's kind only: never the file, its name or the chat
      this.deps.log.warn('A WhatsApp file could not be downloaded', { kind, error: (error as Error).name });
      return reply(DOWNLOAD_FAILED_TEXT);
    }
    if (bytes.length > cap) return reply(tooBigText(kind, bytes.length));
    if (!bytes.length) return reply(DOWNLOAD_FAILED_TEXT);
    const media = {
      mediaType: info?.mediaType ?? 'application/octet-stream',
      size: bytes.length,
      name: info?.name ?? null,
      seconds: info?.seconds ?? null,
      voiceNote: info?.voiceNote ?? false,
    };
    if (kind === 'document') {
      return { ...base, kind, media, quotedId, savedAs: this.keepDocument(bytes, media.name, media.mediaType) };
    }
    privateDir(this.mediaDir);
    writeFileSync(this.mediaFile(message.id), bytes, { mode: 0o600 });
    return { ...base, kind, media, quotedId };
  }

  /** Keeps a document he sent in whatsapp/files, under a safe name of its own, and returns where. */
  private keepDocument(bytes: Buffer, name: string | null, mediaType: string): string {
    privateDir(this.filesDir);
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const fallback = `document${extensionOf(mediaType)}`;
    const safe =
      (name ?? fallback)
        .replace(/[/\\:\u0000-\u001f]/g, '_')
        .replace(/^\.+/, '')
        .slice(-120) || fallback;
    let path = join(this.filesDir, `${day} ${safe}`);
    for (let n = 2; existsSync(path); n++) path = join(this.filesDir, `${day} (${n}) ${safe}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    this.pruneFiles();
    return path;
  }

  /** Keeps the kept documents under FILES_MAX_BYTES in all, letting the oldest go. */
  private pruneFiles(): void {
    const files = readdirSync(this.filesDir)
      .map(name => {
        const path = join(this.filesDir, name);
        const stat = statSync(path);
        return { path, size: stat.size, at: stat.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
    let total = 0;
    for (const file of files) {
      total += file.size;
      // The newest always stays
      if (total > FILES_MAX_BYTES && file !== files[0]) rmSync(file.path, { force: true });
    }
  }

  private mediaFile(id: string): string {
    return join(this.mediaDir, `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.bin`);
  }

  /** Removes the files that waited beside these queued messages. */
  private dropMedia(items: Queued[]): void {
    for (const item of items) {
      if (item.media && item.kind !== 'document') rmSync(this.mediaFile(item.id), { force: true });
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
   * one; a few wrong code-like messages and the code is gone, so it cannot be guessed. Sent in his own "Message
   * yourself" chat, the code is used up there (that chat is his already) and never becomes a task.
   */
  private async connectFrom(message: WaIncoming): Promise<boolean> {
    const code = this.pendingCode();
    if (!code || message.isGroup || message.type !== 'chat') return false;
    if (this.isSelfChat(message.chatId)) {
      if (!message.fromMe || message.body.trim().toUpperCase() !== code) return false;
      const at = millisOf(message.at);
      if (!this.isNew(at)) return false;
      this.saved.connectCode = null;
      this.saved.lastInAt = this.now();
      this.saved.seen = [...this.saved.seen, message.id].slice(-SEEN_MAX);
      this.save();
      await this.sendTo(message.chatId, 'This chat is already yours.').catch(() => {});
      return true;
    }
    if (message.fromMe || /@(g\.us|broadcast|newsletter)$/.test(message.chatId)) return false;
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
    if (!this.isNew(at)) return false;
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

  /** Said since this session was ready (or while its line was down), and not so long ago it is stale. */
  private isNew(at: number): boolean {
    return (
      this.readyAt !== null && at > 0 && at >= this.readyAt - HISTORY_GRACE_MS && at >= this.now() - OFFLINE_MAX_MS
    );
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

  /** The chat an answer goes to; outside quiet hours, anything goes, in them only answers and approvals. */
  private answerChat(request: { kind: WhatsAppNoticeKind; replyTo?: string }): string {
    if (
      !ALWAYS_SENT.has(request.kind) &&
      inQuietHours(new Date(this.now()), this.saved.quietStart, this.saved.quietEnd)
    ) {
      fail('forbidden', 'It is quiet hours: only answers and approvals go out now.');
    }
    const chatId = (request.replyTo && this.chatOf(request.replyTo)) || this.defaultChat();
    if (!chatId) fail('unavailable', 'WhatsApp is not linked on your Mac.');
    return chatId;
  }

  /** His message to show quoted above an answer, when asked and its words are still in memory. */
  private quoteOf(request: { replyTo?: string; quote?: boolean }, chatId: string): WaQuote | undefined {
    if (!request.quote || !request.replyTo) return undefined;
    const quoted = this.quotable.get(request.replyTo);
    if (!quoted || this.chatOf(request.replyTo) !== chatId) return undefined;
    // In the self chat his messages are the account's own
    return { chatId, id: request.replyTo, fromMe: this.isSelfChat(chatId), ...quoted };
  }

  /** A message to react to: one of hers or his by id, or her own last one. */
  private refOf(messageId: string | undefined): WaRef | null {
    if (!messageId) {
      const last = this.saved.own.at(-1);
      return last ? { chatId: last.chatId, id: last.id, fromMe: true } : null;
    }
    const own = this.saved.own.find(item => item.id === messageId);
    if (own) return { chatId: own.chatId, id: own.id, fromMe: true };
    const chatId = this.chatOf(messageId);
    return chatId ? { chatId, id: messageId, fromMe: this.isSelfChat(chatId) } : null;
  }

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
      this.dropMedia(this.saved.queue.filter(item => item.at <= since));
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

/** A link's address made safe to keep: http(s) only, its preview's words trimmed. */
function cleanLink(link: WhatsAppLink): WhatsAppLink | null {
  const url = /^https?:\/\//i.test(link.url) ? link.url : `https://${link.url}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return {
    url: url.slice(0, 2000),
    title: link.title?.trim().slice(0, 300) || null,
    description: link.description?.trim().slice(0, 1000) || null,
  };
}

/** The first web address in his words, when WhatsApp sent no preview of it. */
export function linkInText(text: string): WhatsAppLink | null {
  const match = URL_IN_TEXT.exec(text)?.[0].replace(/[.,;:!?)\]]+$/, '');
  return match ? cleanLink({ url: match, title: null, description: null }) : null;
}

const EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};
const extensionOf = (mediaType: string) => EXTENSIONS[mediaType.split(';')[0].trim()] ?? '';

/** Words to send: her mark taken out (it goes on the end), trimmed, short enough for WhatsApp. */
function bodyOf(text: string): string {
  return text
    .replaceAll(OWN_MARK, '')
    .trim()
    .slice(0, WHATSAPP_TEXT_MAX - OWN_MARK.length);
}

/** An Ogg stream whose first page holds an Opus header: what WhatsApp plays as a voice note. */
export function isOggOpus(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).toString('latin1') === 'OggS' && bytes.subarray(0, 80).includes('OpusHead');
}

/** An error's code and words, whatever shape the driver threw it in. */
function errorText(error: unknown): string {
  if (error instanceof Error) return `${(error as { code?: unknown }).code ?? ''} ${error.message}`;
  return typeof error === 'string' ? error : JSON.stringify(error ?? '');
}
