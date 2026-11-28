import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../log';
import { numberOfJid } from './driver';
import type { WaDriver, WaDriverFactory, WaEvents, WaIncoming, WaLink, WaMediaInfo, WaQuote, WaRef } from './driver';

/**
 * Ava's WhatsApp session through Baileys: WhatsApp's own multi-device protocol over a websocket, with no browser.
 * The login lives in files under the session dir (mode 0700), so a restart reconnects with no new scan. Baileys
 * knows WhatsApp's private @lid ids: a message from one carries the sender's phone id alongside (remoteJidAlt), and
 * Ava can answer in that chat. Nothing here logs a message, a number or a code.
 */

// After a scan WhatsApp closes the socket once and asks for a fresh one; a dropped line is retried the same way
const RECONNECT_MS = 2000;
const RECONNECT_MAX_MS = 60_000;
// A new socket that has neither opened nor closed by now is stuck (seen: an hour of silence after a 408); end it
// and try again, so a dropped line can never hang for good
export const CONNECT_TIMEOUT_MS = 45_000;
const LOGGED_OUT = 401;
const TIMED_OUT = 408;
const RESTART_REQUIRED = 515;

// The service names a person's chat "<digits>@c.us" (WhatsApp Web's form); Baileys says "@s.whatsapp.net"
const PHONE_SERVER = '@s.whatsapp.net';
export const toServiceJid = (jid: string) =>
  jid.endsWith(PHONE_SERVER) ? `${jid.slice(0, -PHONE_SERVER.length)}@c.us` : jid;
export const toBaileysJid = (jid: string) =>
  jid.endsWith('@c.us') ? `${jid.slice(0, -'@c.us'.length)}${PHONE_SERVER}` : jid;

interface BaileysKey {
  remoteJid?: string | null;
  remoteJidAlt?: string;
  participant?: string | null;
  participantAlt?: string;
  fromMe?: boolean | null;
  id?: string | null;
}

interface BaileysMessage {
  key: BaileysKey;
  message?: Record<string, unknown> | null;
  messageTimestamp?: number | { toNumber?: () => number } | null;
}

interface BaileysSocket {
  user?: { id: string; lid?: string } | null;
  ev: { on(event: string, listener: (payload: never) => void): void };
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
    options?: { quoted?: BaileysMessage },
  ): Promise<{ key?: BaileysKey } | undefined>;
  // 'available' and 'unavailable' are the account; the others are one chat
  sendPresenceUpdate(type: string, jid?: string): Promise<void>;
  // Asks the phone to upload a file again when WhatsApp's copy has expired
  updateMediaMessage(message: BaileysMessage): Promise<BaileysMessage>;
  logout(): Promise<void>;
  end(error: Error | undefined): void;
}

export interface BaileysModule {
  makeWASocket(config: Record<string, unknown>): BaileysSocket;
  useMultiFileAuthState(folder: string): Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  jidNormalizedUser(jid: string | undefined): string;
  isPnUser(jid: string | undefined): boolean | undefined;
  // Unwraps disappearing, view-once and edited messages; names the kind of content inside
  normalizeMessageContent(content: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined;
  getContentType(content: Record<string, unknown> | undefined): string | undefined;
  downloadMediaMessage(
    message: BaileysMessage,
    type: 'stream',
    options: Record<string, unknown>,
    ctx: { reuploadRequest: (message: BaileysMessage) => Promise<BaileysMessage>; logger: unknown },
  ): Promise<AsyncIterable<Buffer> & { destroy?: () => void }>;
  Browsers: { macOS(browser: string): [string, string, string] };
}

/** Baileys wants a pino-shaped logger; its lines can carry message contents, so none of them are kept. */
const silent = {
  level: 'silent',
  child: () => silent,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// What a person sends that is not text; a reaction is read on its own (reactionOf). Anything else (key shares,
// settings, receipts, poll votes) is WhatsApp talking to itself, and is ignored without an answer
const MEDIA: Record<string, string> = {
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  locationMessage: 'location',
  liveLocationMessage: 'location',
  contactMessage: 'contact',
  contactsArrayMessage: 'contact',
};

// A count WhatsApp sends as a number, a Long, or a string
function countOf(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : typeof (value as { toNumber?: unknown } | null)?.toNumber === 'function'
          ? (value as { toNumber: () => number }).toNumber()
          : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// A voice note as WhatsApp's own push-to-talk wants it
export const VOICE_MIMETYPE = 'audio/ogg; codecs=opus';

const keyOf = (ref: WaRef): BaileysKey => ({ remoteJid: toBaileysJid(ref.chatId), id: ref.id, fromMe: ref.fromMe });

/** The quoted message for Baileys: enough of it for the bubble above the answer (its words, or a voice note). */
export function quotedOf(quote: WaQuote): BaileysMessage {
  return {
    key: keyOf(quote),
    message:
      quote.voiceSeconds !== null
        ? { audioMessage: { ptt: true, seconds: quote.voiceSeconds } }
        : { conversation: quote.text },
  };
}

const textOf = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** What WhatsApp says about a file: its type, size, name and length. */
function mediaInfoOf(media: Record<string, unknown>): WaMediaInfo {
  return {
    mediaType: textOf(media.mimetype, 100),
    size: countOf(media.fileLength),
    name: textOf(media.fileName, 200) ?? textOf(media.title, 200),
    seconds: countOf(media.seconds),
    voiceNote: media.ptt === true,
  };
}

/** The link WhatsApp previewed in a text message, if any: the address and what the page says it is. */
function linkOf(extended: Record<string, unknown> | undefined): WaLink | undefined {
  const url = textOf(extended?.canonicalUrl, 2000) ?? textOf(extended?.matchedText, 2000);
  if (!url) return undefined;
  return { url, title: textOf(extended?.title, 300), description: textOf(extended?.description, 1000) };
}

/**
 * A reaction: the id of the message it is on and its emoji, empty when it was taken back. Null when it names no
 * message. Whose it is and where are the service's to decide, like any message.
 */
function reactionOf(content: Record<string, unknown>): { targetId: string; emoji: string } | null {
  const reaction = content.reactionMessage as { key?: { id?: unknown } | null; text?: unknown } | undefined;
  const targetId = textOf(reaction?.key?.id, 200);
  if (!targetId) return null;
  return { targetId, emoji: typeof reaction?.text === 'string' ? reaction.text.trim().slice(0, 32) : '' };
}

/** A Baileys message as the service reads it. `download` fetches its file, when it has one. */
export function incomingOfBaileys(
  raw: BaileysMessage,
  lib: Pick<BaileysModule, 'jidNormalizedUser' | 'isPnUser' | 'normalizeMessageContent' | 'getContentType'>,
  download?: (maxBytes: number) => Promise<Buffer>,
): WaIncoming {
  const key = raw.key ?? {};
  const chatId = key.remoteJid ? toServiceJid(lib.jidNormalizedUser(key.remoteJid)) : '';
  const content = lib.normalizeMessageContent(raw.message) ?? {};
  const kind = lib.getContentType(content);
  const extended = content.extendedTextMessage as { text?: unknown; contextInfo?: Record<string, unknown> } | undefined;
  const media = kind ? MEDIA[kind] : undefined;
  const file = media ? ((content[kind!] ?? {}) as Record<string, unknown>) : undefined;
  const text =
    typeof content.conversation === 'string'
      ? content.conversation
      : typeof extended?.text === 'string'
        ? extended.text
        : typeof file?.caption === 'string'
          ? file.caption
          : null;
  const context = (extended?.contextInfo ?? file?.contextInfo) as
    { isForwarded?: unknown; forwardingScore?: unknown; stanzaId?: unknown } | undefined;
  const link = kind === 'extendedTextMessage' ? linkOf(extended as Record<string, unknown>) : undefined;
  // He swiped to reply to this message
  const quotedId = textOf(context?.stanzaId, 200);
  // The sender's phone id, when WhatsApp sends one beside a @lid id
  const phoneJid = [key.remoteJidAlt, key.participantAlt, key.participant, key.remoteJid].find(jid =>
    lib.isPnUser(jid ?? undefined),
  );
  const at = raw.messageTimestamp;
  const reaction = kind === 'reactionMessage' ? reactionOf(content) : null;
  return {
    id: key.id ?? '',
    chatId,
    fromMe: key.fromMe === true,
    forwarded:
      context?.isForwarded === true || (typeof context?.forwardingScore === 'number' && context.forwardingScore > 0),
    isGroup: chatId.endsWith('@g.us'),
    type:
      kind === 'conversation' || kind === 'extendedTextMessage' ? 'chat' : reaction ? 'reaction' : (media ?? 'system'),
    body: text ?? '',
    at: typeof at === 'number' ? at : typeof at?.toNumber === 'function' ? at.toNumber() : Number(at ?? 0),
    senderNumber: phoneJid ? numberOfJid(lib.jidNormalizedUser(phoneJid)) : null,
    ...(file ? { media: mediaInfoOf(file) } : {}),
    ...(link ? { link } : {}),
    ...(file && download ? { download } : {}),
    ...(quotedId ? { quotedId } : {}),
    ...(reaction ? { reaction } : {}),
  };
}

/** A file's bytes, stopping as soon as it passes maxBytes (WhatsApp's own size can be wrong). */
export async function readCapped(chunks: AsyncIterable<Buffer> & { destroy?: () => void }, maxBytes: number) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    if (size > maxBytes) {
      chunks.destroy?.();
      throw new Error('The file is larger than Ava takes.');
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

async function loadBaileys(): Promise<BaileysModule> {
  const loaded = (await import('baileys')) as unknown as BaileysModule & { default?: BaileysModule['makeWASocket'] };
  const makeWASocket = typeof loaded.makeWASocket === 'function' ? loaded.makeWASocket : loaded.default;
  if (typeof makeWASocket !== 'function') throw new Error('The WhatsApp client is not installed.');
  return { ...loaded, makeWASocket };
}

export function baileysDriver(log: Logger, load: () => Promise<BaileysModule> = loadBaileys): WaDriverFactory {
  return options => {
    let socket: BaileysSocket | null = null;
    let stopped = false;
    let retryMs = RECONNECT_MS;
    let opened = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    // Tries since the line last dropped; 0 while open
    let attempt = 0;
    // Shown online only while typing or recording to a chat, then offline again (markOnlineOnConnect is off, so
    // his phone keeps its notifications)
    let online = false;
    let retryLater: () => void = () => {};
    const connected = () => {
      if (!socket) throw new Error('WhatsApp is not connected.');
      return socket;
    };
    const authDir = join(options.sessionDir, 'baileys');

    const driver: WaDriver = {
      async start(events: WaEvents) {
        // What the browser-based client left behind (a whole browser profile) is not needed any more
        const oldProfile = join(options.sessionDir, 'browser');
        if (existsSync(oldProfile)) rmSync(oldProfile, { recursive: true, force: true });
        const lib = await load();
        const { state, saveCreds } = await lib.useMultiFileAuthState(authDir);

        const connect = () => {
          if (stopped) return;
          const current = lib.makeWASocket({
            auth: state,
            logger: silent,
            browser: lib.Browsers.macOS('Ava Brain'),
            markOnlineOnConnect: false,
            syncFullHistory: false,
          });
          socket = current;
          const mine = () => !stopped && socket === current;
          if (watchdog) clearTimeout(watchdog);
          watchdog = null;
          // Only a saved login is expected to open quickly; a first link waits for a scan as long as it takes
          const savedLogin = Boolean((state as { creds?: { me?: unknown } }).creds?.me);
          if (savedLogin)
            watchdog = setTimeout(() => {
              if (!mine()) return;
              log.warn('WhatsApp did not answer; trying again', { attempt });
              socket = null;
              try {
                current.end(undefined);
              } catch {
                // already gone
              }
              retryLater();
            }, CONNECT_TIMEOUT_MS);
          current.ev.on('creds.update', (() => void saveCreds().catch(() => {})) as never);
          current.ev.on('connection.update', ((update: {
            qr?: string;
            connection?: string;
            lastDisconnect?: { error?: { output?: { statusCode?: number } } };
          }) => {
            if (!mine()) return;
            if (update.qr) events.qr(update.qr);
            if (update.connection === 'open') {
              if (watchdog) clearTimeout(watchdog);
              attempt = 0;
              retryMs = RECONNECT_MS;
              const user = current.user;
              opened = true;
              const selfIds = [user?.id, user?.lid].filter(Boolean).map(id => toServiceJid(lib.jidNormalizedUser(id!)));
              events.ready({ number: numberOfJid(selfIds[0]) ?? '', selfIds });
            }
            if (update.connection === 'close') {
              if (watchdog) clearTimeout(watchdog);
              online = false;
              const code = update.lastDisconnect?.error?.output?.statusCode;
              socket = null;
              if (code === LOGGED_OUT) {
                // WhatsApp will never take this login again: without its files, Relink shows a fresh code to scan
                // instead of being refused with the old one every time
                rmSync(authDir, { recursive: true, force: true });
                events.disconnected('WhatsApp signed Ava out on your phone. Press Relink and scan the new code.');
                return;
              }
              // The codes ran out with nobody scanning: stop rather than show new ones forever
              if (code === TIMED_OUT && !opened && !(state as { creds?: { me?: unknown } }).creds?.me) {
                events.failed('Linking did not finish. Start again and scan the new code within a few minutes.');
                return;
              }
              // A fresh socket right after a scan; otherwise back off a little each time the line drops
              if (code === RESTART_REQUIRED) {
                timer = setTimeout(connect, 0);
                return;
              }
              log.warn('WhatsApp connection dropped; reconnecting', { code: code ?? null });
              retryLater();
            }
          }) as never);
          current.ev.on('messages.upsert', ((upsert: { messages: BaileysMessage[]; type: string }) => {
            // 'notify' is what just arrived. 'append' is history, her own sends coming back, and also what others
            // sent while the line was down (delivered on reconnect): only the last counts, and the service still
            // drops anything dated before the session was ready
            if (!mine() || (upsert.type !== 'notify' && upsert.type !== 'append')) return;
            for (const message of upsert.messages) {
              if (upsert.type === 'append' && message.key.fromMe !== false) continue;
              const download = async (maxBytes: number) =>
                readCapped(
                  await lib.downloadMediaMessage(
                    message,
                    'stream',
                    {},
                    { reuploadRequest: next => current.updateMediaMessage(next), logger: silent },
                  ),
                  maxBytes,
                );
              events.message(incomingOfBaileys(message, lib, download));
            }
          }) as never);
        };
        retryLater = () => {
          if (stopped) return;
          const wait = retryMs;
          retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
          attempt++;
          // Only a session that was linked reports it; a first link has its own states (scan, failed)
          if (opened) events.reconnecting?.({ attempt, nextAt: Date.now() + wait });
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (opened) events.reconnecting?.({ attempt, nextAt: null });
            connect();
          }, wait);
        };
        connect();
      },
      async sendText(chatId, text, options) {
        const quoted = options?.quote ? { quoted: quotedOf(options.quote) } : undefined;
        const sent = await connected().sendMessage(toBaileysJid(chatId), { text }, quoted);
        return sent?.key?.id ?? null;
      },
      async sendVoice(chatId, voice, options) {
        const quoted = options?.quote ? { quoted: quotedOf(options.quote) } : undefined;
        // The length and bars given, so Baileys never reaches for ffmpeg or a decoder to work them out
        const sent = await connected().sendMessage(
          toBaileysJid(chatId),
          {
            audio: voice.audio,
            ptt: true,
            mimetype: VOICE_MIMETYPE,
            seconds: voice.seconds,
            ...(voice.waveform ? { waveform: Uint8Array.from(voice.waveform) } : {}),
          },
          quoted,
        );
        return sent?.key?.id ?? null;
      },
      async sendImage(chatId, media, options) {
        const quoted = options?.quote ? { quoted: quotedOf(options.quote) } : undefined;
        const content = {
          image: media.data,
          mimetype: media.mimetype,
          ...(media.caption ? { caption: media.caption } : {}),
        };
        const sent = await connected().sendMessage(toBaileysJid(chatId), content, quoted);
        return sent?.key?.id ?? null;
      },
      async sendVideo(chatId, media, options) {
        const quoted = options?.quote ? { quoted: quotedOf(options.quote) } : undefined;
        const content = {
          video: media.data,
          mimetype: media.mimetype,
          ...(media.caption ? { caption: media.caption } : {}),
        };
        const sent = await connected().sendMessage(toBaileysJid(chatId), content, quoted);
        return sent?.key?.id ?? null;
      },
      async sendDocument(chatId, media, options) {
        const quoted = options?.quote ? { quoted: quotedOf(options.quote) } : undefined;
        const sent = await connected().sendMessage(
          toBaileysJid(chatId),
          {
            document: media.data,
            mimetype: media.mimetype,
            fileName: media.fileName ?? 'file',
            ...(media.caption ? { caption: media.caption } : {}),
          },
          quoted,
        );
        return sent?.key?.id ?? null;
      },
      async react(message, emoji) {
        await connected().sendMessage(toBaileysJid(message.chatId), { react: { text: emoji, key: keyOf(message) } });
      },
      async edit(message, text) {
        await connected().sendMessage(toBaileysJid(message.chatId), { text, edit: keyOf(message) });
      },
      async remove(message) {
        await connected().sendMessage(toBaileysJid(message.chatId), { delete: keyOf(message) });
      },
      async presence(chatId, state) {
        const current = connected();
        if (state === 'paused') {
          await current.sendPresenceUpdate('paused', toBaileysJid(chatId));
          if (online) await current.sendPresenceUpdate('unavailable');
          online = false;
          return;
        }
        if (!online) await current.sendPresenceUpdate('available');
        online = true;
        await current.sendPresenceUpdate(state, toBaileysJid(chatId));
      },
      async logout() {
        await socket?.logout();
      },
      async stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (watchdog) clearTimeout(watchdog);
        const current = socket;
        socket = null;
        current?.end(undefined);
      },
    };
    return driver;
  };
}
