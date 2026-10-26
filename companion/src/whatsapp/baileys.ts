import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../log';
import { numberOfJid } from './driver';
import type { WaDriver, WaDriverFactory, WaEvents, WaIncoming, WaLink, WaMediaInfo } from './driver';

/**
 * Ava's WhatsApp session through Baileys: WhatsApp's own multi-device protocol over a websocket, with no browser.
 * The login lives in files under the session dir (mode 0700), so a restart reconnects with no new scan. Baileys
 * knows WhatsApp's private @lid ids: a message from one carries the sender's phone id alongside (remoteJidAlt), and
 * Ava can answer in that chat. Nothing here logs a message, a number or a code.
 */

// After a scan WhatsApp closes the socket once and asks for a fresh one; a dropped line is retried the same way
const RECONNECT_MS = 2000;
const RECONNECT_MAX_MS = 60_000;
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
  sendMessage(jid: string, content: { text: string }): Promise<{ key?: BaileysKey } | undefined>;
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

// What a person sends that is not text; anything else (key shares, settings, receipts, reactions, poll votes) is
// WhatsApp talking to itself, and is ignored without an answer
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
    { isForwarded?: unknown; forwardingScore?: unknown } | undefined;
  const link = kind === 'extendedTextMessage' ? linkOf(extended as Record<string, unknown>) : undefined;
  // The sender's phone id, when WhatsApp sends one beside a @lid id
  const phoneJid = [key.remoteJidAlt, key.participantAlt, key.participant, key.remoteJid].find(jid =>
    lib.isPnUser(jid ?? undefined),
  );
  const at = raw.messageTimestamp;
  return {
    id: key.id ?? '',
    chatId,
    fromMe: key.fromMe === true,
    forwarded:
      context?.isForwarded === true || (typeof context?.forwardingScore === 'number' && context.forwardingScore > 0),
    isGroup: chatId.endsWith('@g.us'),
    type: kind === 'conversation' || kind === 'extendedTextMessage' ? 'chat' : (media ?? 'system'),
    body: text ?? '',
    at: typeof at === 'number' ? at : typeof at?.toNumber === 'function' ? at.toNumber() : Number(at ?? 0),
    senderNumber: phoneJid ? numberOfJid(lib.jidNormalizedUser(phoneJid)) : null,
    ...(file ? { media: mediaInfoOf(file) } : {}),
    ...(link ? { link } : {}),
    ...(file && download ? { download } : {}),
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
          current.ev.on('creds.update', (() => void saveCreds().catch(() => {})) as never);
          current.ev.on('connection.update', ((update: {
            qr?: string;
            connection?: string;
            lastDisconnect?: { error?: { output?: { statusCode?: number } } };
          }) => {
            if (!mine()) return;
            if (update.qr) events.qr(update.qr);
            if (update.connection === 'open') {
              retryMs = RECONNECT_MS;
              const user = current.user;
              opened = true;
              const selfIds = [user?.id, user?.lid].filter(Boolean).map(id => toServiceJid(lib.jidNormalizedUser(id!)));
              events.ready({ number: numberOfJid(selfIds[0]) ?? '', selfIds });
            }
            if (update.connection === 'close') {
              const code = update.lastDisconnect?.error?.output?.statusCode;
              socket = null;
              if (code === LOGGED_OUT) {
                events.disconnected('This Mac was removed from Linked devices on your phone.');
                return;
              }
              // The codes ran out with nobody scanning: stop rather than show new ones forever
              if (code === TIMED_OUT && !opened && !(state as { creds?: { me?: unknown } }).creds?.me) {
                events.failed('Linking did not finish. Start again and scan the new code within a few minutes.');
                return;
              }
              // A fresh socket right after a scan; otherwise back off a little each time the line drops
              const wait = code === RESTART_REQUIRED ? 0 : retryMs;
              retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
              if (code !== RESTART_REQUIRED)
                log.warn('WhatsApp connection dropped; reconnecting', { code: code ?? null });
              timer = setTimeout(connect, wait);
            }
          }) as never);
          current.ev.on('messages.upsert', ((upsert: { messages: BaileysMessage[]; type: string }) => {
            // 'notify' is what just arrived; 'append' is history being synced
            if (!mine() || upsert.type !== 'notify') return;
            for (const message of upsert.messages) {
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
        connect();
      },
      async sendText(chatId, text) {
        if (!socket) throw new Error('WhatsApp is not connected.');
        const sent = await socket.sendMessage(toBaileysJid(chatId), { text });
        return sent?.key?.id ?? null;
      },
      async logout() {
        await socket?.logout();
      },
      async stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        const current = socket;
        socket = null;
        current?.end(undefined);
      },
    };
    return driver;
  };
}
