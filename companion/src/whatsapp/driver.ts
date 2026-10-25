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
  // 'chat' for text; anything else is media, a sticker, a location…
  type: string;
  body: string;
  // Seconds or milliseconds since the epoch; the service only uses it for order
  at: number;
  // The sender's phone number in digits, when the client knows it (a chat id in @lid form does not show it)
  senderNumber: string | null;
  // Passed on from another chat: someone else's words
  forwarded: boolean;
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
  message: (message: WaIncoming) => void;
}

export interface WaDriver {
  /** Starts the session and returns; what happens next arrives as events. */
  start(events: WaEvents): Promise<void>;
  /** Sends text to a chat; the message's id when the client gives one. */
  sendText(chatId: string, text: string): Promise<string | null>;
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
