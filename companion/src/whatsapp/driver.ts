/**
 * What Ava's WhatsApp needs from a WhatsApp Web client, so the rules in ./service.ts never depend on one.
 * The real one is Baileys (./baileys.ts); tests use a stand-in. A driver reports every message the session
 * sees; the service decides, before anything is kept, whether it is the owner's.
 */

/** A message as the driver saw it. Only the service reads it, and it keeps nothing of one not the owner's. */
export interface WaIncoming {
  id: string;
  // The chat it is in: the self chat, a person, a group
  chatId: string;
  fromMe: boolean;
  isGroup: boolean;
  // 'chat' for text; 'audio', 'image', 'document', 'video', 'sticker', 'location', 'contact'; 'system' for
  // WhatsApp's own bookkeeping
  type: string;
  body: string;
  // Seconds or milliseconds since the epoch; the service only uses it for order
  at: number;
  // The sender's phone number in digits, when the client knows it (a chat id in @lid form does not show it)
  senderNumber: string | null;
  // Passed on from another chat: someone else's words
  forwarded: boolean;
  // A voice note, picture, document…: what WhatsApp says about the file (body holds its caption)
  media?: WaMediaInfo;
  // A link WhatsApp previewed in a text message
  link?: WaLink;
  // Fetches the file, refusing one over maxBytes; only called for the owner's messages
  download?: (maxBytes: number) => Promise<Buffer>;
  // The message this one quotes (he swiped to reply to it), by id
  quotedId?: string | null;
  // type 'reaction': the message reacted to, by id, and the emoji (empty when the reaction was taken back)
  reaction?: { targetId: string; emoji: string };
}

/** A message in a chat, as WhatsApp addresses it for a reaction, an edit or a delete. */
export interface WaRef {
  chatId: string;
  id: string;
  fromMe: boolean;
}

/** A message shown quoted above an answer: its words, or that it was a voice note this long. */
export interface WaQuote extends WaRef {
  text: string;
  voiceSeconds: number | null;
}

export interface WaVoice {
  // Ogg/Opus
  audio: Buffer;
  seconds: number;
  // Loudness 0-100 for each bar of the bubble
  waveform?: number[];
}

export type WaPresence = 'composing' | 'recording' | 'paused';

export interface WaMediaInfo {
  mediaType: string | null;
  // What WhatsApp says the file is, in bytes (the download is still capped)
  size: number | null;
  name: string | null;
  seconds: number | null;
  // Recorded in the chat (push to talk)
  voiceNote: boolean;
}

export interface WaLink {
  url: string;
  title: string | null;
  description: string | null;
}

/** The linked account: its number, and every id its own chat goes by (number@c.us, an @lid id). */
export interface WaAccount {
  number: string;
  selfIds: string[];
}

export interface WaEvents {
  // A code to scan; a new one replaces the last
  qr: (code: string) => void;
  ready: (account: WaAccount) => void;
  disconnected: (reason: string) => void;
  // Could not start, or linking gave up (the codes ran out)
  failed: (message: string) => void;
  // A linked session lost its line and is retrying: which try, and when the next starts (null: running now)
  reconnecting?: (info: { attempt: number; nextAt: number | null }) => void;
  message: (message: WaIncoming) => void;
}

export interface WaDriver {
  /** Starts the session and returns; what happens next arrives as events. */
  start(events: WaEvents): Promise<void>;
  /** Sends text to a chat, quoting a message when asked; the message's id when the client gives one. */
  sendText(chatId: string, text: string, options?: { quote?: WaQuote }): Promise<string | null>;
  /** Sends a voice note (push to talk). */
  sendVoice?(chatId: string, voice: WaVoice, options?: { quote?: WaQuote }): Promise<string | null>;
  /** Reacts to a message; an empty emoji takes the reaction back. */
  react?(message: WaRef, emoji: string): Promise<void>;
  /** Changes the words of one of her own messages. */
  edit?(message: WaRef, text: string): Promise<void>;
  /** Deletes one of her own messages for everyone. */
  remove?(message: WaRef): Promise<void>;
  /** Shows "typing…" or "recording…" in a chat, or stops showing it. */
  presence?(chatId: string, state: WaPresence): Promise<void>;
  /** Removes this Mac from the phone's Linked devices, when the client can. */
  logout?(): Promise<void>;
  stop(): Promise<void>;
}

export interface WaDriverOptions {
  // Where the session lives (the browser profile and the client's own files), mode 0700
  sessionDir: string;
  // Chrome, Brave or Chromium on this Mac; null lets the client look
  executablePath: string | null;
}

export type WaDriverFactory = (options: WaDriverOptions) => WaDriver;

/** Digits only: "+234 801-234-5678", "2348012345678@c.us" → "2348012345678"; a @lid or group id → null. */
export function numberOfJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const [user, server] = jid.split('@');
  if (server && server !== 'c.us' && server !== 's.whatsapp.net') return null;
  const digits = (user ?? '').split(':')[0].replace(/[^0-9]/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}
