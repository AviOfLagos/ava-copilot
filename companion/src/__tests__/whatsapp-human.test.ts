import { afterEach, describe, expect, it } from 'vitest';
import { getContentType, isPnUser, jidNormalizedUser, normalizeMessageContent } from 'baileys';
import { memoryLogger } from '../log';
import { baileysDriver, incomingOfBaileys, quotedOf, VOICE_MIMETYPE } from '../whatsapp/baileys';
import type { BaileysModule } from '../whatsapp/baileys';
import type { WaDriver, WaEvents, WaIncoming, WaMedia, WaPresence, WaQuote, WaRef, WaVoice } from '../whatsapp/driver';
import {
  DELETE_WINDOW_MS,
  EDIT_TOO_LATE_TEXT,
  EDIT_VOICE_TEXT,
  EDIT_WINDOW_MS,
  bytesAre,
  isOggOpus,
  NOTHING_TO_CHANGE_TEXT,
  OWN_MARK,
  REACTIONS_PER_HOUR,
  WhatsAppService,
} from '../whatsapp/service';
import { tempDir } from './helpers';

// Ava answering like a person (#19): voice notes, quotes, reactions, typing, and her last message changed. Nothing
// here talks to WhatsApp: the service gets a stand-in driver, the Baileys driver a stand-in socket.

const ME = '2348011111111';
const SELF = `${ME}@c.us`;
const PHONE = '2348022222222';
const PHONE_CHAT = '77777@lid';

// The smallest thing that passes for Ogg/Opus: a first page holding an Opus header
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead'), Buffer.alloc(40)]);

class FakeDriver implements WaDriver {
  events: WaEvents | null = null;
  sent: { chatId: string; text: string; quote?: WaQuote }[] = [];
  voices: { chatId: string; voice: WaVoice; quote?: WaQuote }[] = [];
  reactions: { message: WaRef; emoji: string }[] = [];
  media: { how: 'image' | 'document'; chatId: string; media: WaMedia }[] = [];
  edits: { message: WaRef; text: string }[] = [];
  removed: WaRef[] = [];
  presences: { chatId: string; state: WaPresence }[] = [];
  private next = 0;

  async start(events: WaEvents) {
    this.events = events;
  }
  async sendText(chatId: string, text: string, options?: { quote?: WaQuote }) {
    this.sent.push({
      chatId,
      text: text.replaceAll(OWN_MARK, ''),
      ...(options?.quote ? { quote: options.quote } : {}),
    });
    return `sent-${++this.next}`;
  }
  async sendVoice(chatId: string, voice: WaVoice, options?: { quote?: WaQuote }) {
    this.voices.push({ chatId, voice, ...(options?.quote ? { quote: options.quote } : {}) });
    return `voice-${++this.next}`;
  }
  async sendImage(chatId: string, media: WaMedia) {
    this.media.push({ how: 'image', chatId, media });
    return `image-${++this.next}`;
  }
  async sendDocument(chatId: string, media: WaMedia) {
    this.media.push({ how: 'document', chatId, media });
    return `doc-${++this.next}`;
  }
  async react(message: WaRef, emoji: string) {
    this.reactions.push({ message, emoji });
  }
  async edit(message: WaRef, text: string) {
    this.edits.push({ message, text });
  }
  async remove(message: WaRef) {
    this.removed.push(message);
  }
  async presence(chatId: string, state: WaPresence) {
    this.presences.push({ chatId, state });
  }
  async stop() {}
  deliver(message: Partial<WaIncoming>) {
    this.events!.message({
      id: `m-${Math.random()}`,
      chatId: SELF,
      fromMe: true,
      isGroup: false,
      type: 'chat',
      body: 'hello',
      at: 9_999_999_999,
      senderNumber: null,
      forwarded: false,
      ...message,
    });
  }
}

const dirs: { remove: () => void }[] = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.remove();
});

async function linked(options: { limit?: number; phone?: boolean } = {}) {
  const dir = tempDir();
  dirs.push(dir);
  let now = 1_000_000;
  const driver = new FakeDriver();
  const service = new WhatsAppService({
    dataDir: dir.path,
    log: memoryLogger(),
    driver: () => driver,
    findBrowser: () => null,
    now: () => now,
    limitPerHour: options.limit,
  });
  await service.init();
  service.setQuietHours('00:00', '00:00');
  await service.link();
  driver.events!.ready({ number: ME, selfIds: [SELF] });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  if (options.phone) {
    // His own phone writes to Ava's number: that chat is his
    service.setOwner(PHONE);
    driver.deliver({ id: 'hello', chatId: PHONE_CHAT, fromMe: false, body: 'hi', senderNumber: PHONE });
    await settle();
    service.ack(['hello']);
  }
  return { driver, service, settle, advance: (ms: number) => void (now += ms) };
}

const voice = (extra: Record<string, unknown> = {}) => ({
  audio: OGG.toString('base64'),
  seconds: 3,
  kind: 'reply' as const,
  ...extra,
});

describe('Ava answering like a person', () => {
  it('sends a voice note to the chat his message came from, counted toward the hour', async () => {
    const { driver, service, settle } = await linked({ limit: 2, phone: true });
    driver.deliver({ id: 'v1', chatId: PHONE_CHAT, fromMe: false, body: 'what time is it', senderNumber: PHONE });
    await settle();
    const waveform = Array.from({ length: 64 }, (_, i) => i);
    const status = await service.sendVoice(voice({ replyTo: 'v1', waveform }));
    expect(driver.voices).toHaveLength(1);
    expect(driver.voices[0]).toMatchObject({ chatId: PHONE_CHAT, voice: { seconds: 3, waveform } });
    expect(driver.voices[0].voice.audio.equals(OGG)).toBe(true);
    expect(status.sentLastHour).toBe(1);
    // The hour holds for voice notes like for words
    await service.sendTo(PHONE_CHAT, 'one more');
    await expect(service.sendVoice(voice({ replyTo: 'v1' }))).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('refuses a voice note that is not Ogg/Opus', async () => {
    const { driver, service } = await linked();
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(80)]).toString('base64');
    await expect(service.sendVoice(voice({ audio: wav }))).rejects.toMatchObject({ kind: 'invalid' });
    expect(driver.voices).toHaveLength(0);
    expect(isOggOpus(OGG)).toBe(true);
  });

  it('keeps quiet hours for voice notes too, except answers', async () => {
    const { service } = await linked();
    service.setQuietHours('00:00', '23:59');
    await expect(service.sendVoice(voice({ kind: 'brief' }))).rejects.toMatchObject({ kind: 'forbidden' });
  });

  describe('pictures, videos and files (#204)', () => {
    const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n'), Buffer.alloc(40)]);
    const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(40)]);
    const media = (extra: Record<string, unknown> = {}) => ({
      media: 'image' as const,
      data: PNG.toString('base64'),
      mimetype: 'image/png',
      kind: 'reply' as const,
      ...extra,
    });

    it('sends a picture with its caption to his chat, counted toward the hour', async () => {
      const { driver, service, settle } = await linked({ limit: 1, phone: true });
      driver.deliver({ id: 'p1', chatId: PHONE_CHAT, fromMe: false, body: 'make me a picture', senderNumber: PHONE });
      await settle();
      const status = await service.sendMedia(media({ replyTo: 'p1', caption: '  A solar panel at sunset  ' }));
      expect(driver.media).toHaveLength(1);
      expect(driver.media[0]).toMatchObject({
        how: 'image',
        chatId: PHONE_CHAT,
        media: { mimetype: 'image/png', caption: 'A solar panel at sunset' },
      });
      expect(driver.media[0].media.data.equals(PNG)).toBe(true);
      expect(status.sentLastHour).toBe(1);
      await expect(service.sendMedia(media({ replyTo: 'p1' }))).rejects.toMatchObject({ kind: 'rate_limit' });
    });

    it('sends a file under its own name', async () => {
      const { driver, service } = await linked();
      await service.sendMedia(
        media({
          media: 'document',
          data: PDF.toString('base64'),
          mimetype: 'application/pdf',
          fileName: 'Invoice.pdf',
        }),
      );
      expect(driver.media[0]).toMatchObject({ how: 'document', chatId: SELF, media: { fileName: 'Invoice.pdf' } });
    });

    it('refuses bytes that are not what the type says, a type of the wrong kind, and too big', async () => {
      const { driver, service } = await linked();
      await expect(service.sendMedia(media({ data: PDF.toString('base64') }))).rejects.toMatchObject({
        kind: 'invalid',
      });
      await expect(service.sendMedia(media({ mimetype: 'application/pdf' }))).rejects.toMatchObject({
        kind: 'invalid',
      });
      const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
      await expect(service.sendMedia(media({ data: big }))).rejects.toMatchObject({ kind: 'invalid' });
      expect(driver.media).toHaveLength(0);
      expect(bytesAre('text/plain', Buffer.from('hello'))).toBe(true);
      expect(bytesAre('text/plain', Buffer.from([0x68, 0, 0x69]))).toBe(false);
    });

    it('says plainly when the client cannot send that kind', async () => {
      const { service } = await linked();
      const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(40)]).toString('base64');
      await expect(
        service.sendMedia(media({ media: 'video', data: mp4, mimetype: 'video/mp4' })),
      ).rejects.toMatchObject({
        kind: 'unavailable',
      });
      expect(service.status().abilities).toEqual(expect.arrayContaining(['send_image', 'send_document']));
      expect(service.status().abilities).not.toContain('send_video');
    });

    it('keeps quiet hours for pictures too, except answers', async () => {
      const { service } = await linked();
      service.setQuietHours('00:00', '23:59');
      await expect(service.sendMedia(media({ kind: 'brief' }))).rejects.toMatchObject({ kind: 'forbidden' });
    });
  });

  it('quotes the message an answer is for, only when asked and only his', async () => {
    const { driver, service, settle } = await linked({ phone: true });
    driver.deliver({ id: 'q1', chatId: PHONE_CHAT, fromMe: false, body: 'book the flight', senderNumber: PHONE });
    driver.deliver({ id: 'q2', chatId: PHONE_CHAT, fromMe: false, type: 'audio', body: '', senderNumber: PHONE });
    await settle();
    await service.send({ text: 'Booked.', kind: 'reply', replyTo: 'q1', quote: true });
    await service.send({ text: 'No quote.', kind: 'reply', replyTo: 'q1' });
    expect(driver.sent.at(-2)).toMatchObject({
      text: 'Booked.',
      quote: { chatId: PHONE_CHAT, id: 'q1', fromMe: false, text: 'book the flight', voiceSeconds: null },
    });
    expect(driver.sent.at(-1)!.quote).toBeUndefined();
    // A message Ava never kept (another chat, or before a restart) is answered unquoted
    await service.send({ text: 'Hm.', kind: 'reply', replyTo: 'unknown', quote: true });
    expect(driver.sent.at(-1)!.quote).toBeUndefined();
  });

  it('quotes in the self chat as the account’s own message', async () => {
    const { driver, service, settle } = await linked();
    driver.deliver({ id: 's1', body: 'remind me' });
    await settle();
    await service.send({ text: 'Done.', kind: 'reply', replyTo: 's1', quote: true });
    expect(driver.sent.at(-1)!.quote).toMatchObject({ chatId: SELF, id: 's1', fromMe: true });
  });

  it('reacts on his message, on hers, and on her last; never outside his chats', async () => {
    const { driver, service, settle } = await linked({ phone: true });
    driver.deliver({ id: 'r1', chatId: PHONE_CHAT, fromMe: false, body: 'do it', senderNumber: PHONE });
    await settle();
    await service.react({ emoji: '👍', messageId: 'r1' });
    expect(driver.reactions.at(-1)).toEqual({ message: { chatId: PHONE_CHAT, id: 'r1', fromMe: false }, emoji: '👍' });
    await expect(service.react({ emoji: '🔥' })).rejects.toMatchObject({ message: NOTHING_TO_CHANGE_TEXT });
    await service.sendTo(PHONE_CHAT, 'Here it is');
    await service.react({ emoji: '🔥' });
    expect(driver.reactions.at(-1)).toEqual({
      message: { chatId: PHONE_CHAT, id: expect.stringMatching(/^sent-/), fromMe: true },
      emoji: '🔥',
    });
    // A message id from any other chat is unknown to Ava
    driver.deliver({ id: 'x', chatId: '99999@lid', fromMe: false, body: 'stranger', senderNumber: '2348099999999' });
    await settle();
    await expect(service.react({ emoji: '👍', messageId: 'x' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('holds reactions to an hourly limit of their own, apart from messages', async () => {
    const { driver, service, settle, advance } = await linked({ limit: 1 });
    driver.deliver({ id: 'm1', body: 'go' });
    await settle();
    for (let i = 0; i < REACTIONS_PER_HOUR; i++) await service.react({ emoji: '👍', messageId: 'm1' });
    await expect(service.react({ emoji: '✅', messageId: 'm1' })).rejects.toMatchObject({ kind: 'rate_limit' });
    // Messages are not used up by reactions
    await service.sendTo(SELF, 'still sends');
    advance(60 * 60_000 + 1);
    await service.react({ emoji: '✅', messageId: 'm1' });
    expect(driver.reactions.at(-1)!.emoji).toBe('✅');
  });

  it('deletes her own last message when told, then the one before', async () => {
    const { driver, service } = await linked();
    await expect(service.revise({ action: 'delete' })).rejects.toMatchObject({ message: NOTHING_TO_CHANGE_TEXT });
    await service.sendTo(SELF, 'first');
    await service.sendVoice(voice());
    await service.revise({ action: 'delete' });
    expect(driver.removed).toEqual([{ chatId: SELF, id: 'voice-2', fromMe: true }]);
    await service.revise({ action: 'delete' });
    expect(driver.removed.at(-1)!.id).toBe('sent-1');
  });

  it('refuses to delete a message older than WhatsApp allows', async () => {
    const { service, advance } = await linked();
    await service.sendTo(SELF, 'old');
    advance(DELETE_WINDOW_MS + 1);
    await expect(service.revise({ action: 'delete' })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('edits her last words within 15 minutes, keeping her mark', async () => {
    const { driver, service, advance } = await linked();
    await service.sendTo(SELF, 'Meeting at 3');
    await service.revise({ action: 'edit', text: 'Meeting at 4' });
    expect(driver.edits).toEqual([
      { message: { chatId: SELF, id: 'sent-1', fromMe: true }, text: `Meeting at 4${OWN_MARK}` },
    ]);
    advance(EDIT_WINDOW_MS + 1);
    await expect(service.revise({ action: 'edit', text: 'later' })).rejects.toMatchObject({
      message: EDIT_TOO_LATE_TEXT,
    });
    await service.sendVoice(voice());
    await expect(service.revise({ action: 'edit', text: 'words' })).rejects.toMatchObject({
      message: EDIT_VOICE_TEXT,
    });
  });

  it('counts an edit or delete toward the hour', async () => {
    const { service } = await linked({ limit: 1 });
    await service.sendTo(SELF, 'one');
    await expect(service.revise({ action: 'delete' })).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('shows typing in his phone’s chat, never in the self chat, never elsewhere', async () => {
    const { driver, service, settle } = await linked({ phone: true });
    driver.deliver({ id: 't1', chatId: PHONE_CHAT, fromMe: false, body: 'find it', senderNumber: PHONE });
    driver.deliver({ id: 't2', body: 'in the self chat' });
    await settle();
    await service.presence({ state: 'composing', replyTo: 't1' });
    await service.presence({ state: 'recording', replyTo: 't2' });
    await service.presence({ state: 'paused', replyTo: 't1' });
    expect(driver.presences).toEqual([
      { chatId: PHONE_CHAT, state: 'composing' },
      { chatId: PHONE_CHAT, state: 'paused' },
    ]);
  });

  it('passes on the id of the message his quotes', async () => {
    const { driver, service, settle } = await linked();
    driver.deliver({ id: 'c1', body: 'react 🔥 to that', quotedId: 'sent-9' });
    await settle();
    expect(service.pull()[0]).toMatchObject({ id: 'c1', quotedId: 'sent-9' });
  });
});

// ── The Baileys driver ──

class FakeSocket {
  listeners = new Map<string, (payload: unknown) => void>();
  user: { id: string; lid?: string } | null = { id: `${ME}:7@s.whatsapp.net` };
  sent: { jid: string; content: Record<string, unknown>; options?: unknown }[] = [];
  presence: { type: string; jid?: string }[] = [];
  ev = { on: (event: string, listener: (payload: unknown) => void) => void this.listeners.set(event, listener) };
  async sendMessage(jid: string, content: Record<string, unknown>, options?: unknown) {
    this.sent.push({ jid, content, ...(options ? { options } : {}) });
    return { key: { id: `sent-${this.sent.length}` } };
  }
  async sendPresenceUpdate(type: string, jid?: string) {
    this.presence.push({ type, ...(jid ? { jid } : {}) });
  }
  async updateMediaMessage(message: unknown) {
    return message;
  }
  async logout() {}
  end() {}
}

async function baileys() {
  const sockets: FakeSocket[] = [];
  const lib = {
    makeWASocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    useMultiFileAuthState: async () => ({ state: { creds: {} }, saveCreds: async () => {} }),
    jidNormalizedUser,
    isPnUser,
    normalizeMessageContent,
    getContentType,
    downloadMediaMessage: async () => {
      throw new Error('no media');
    },
    Browsers: { macOS: (name: string) => ['Mac OS', name, '14'] },
  } as unknown as BaileysModule;
  const dir = tempDir();
  dirs.push(dir);
  const driver = baileysDriver(memoryLogger(), async () => lib)({ sessionDir: dir.path, executablePath: null });
  const noop = () => {};
  await driver.start({ qr: noop, ready: noop, disconnected: noop, failed: noop, message: noop });
  return { driver, socket: sockets[0] };
}

describe('Baileys driver, like a person', () => {
  it('sends a voice note as push to talk, with its length and bars, quoting when asked', async () => {
    const { driver, socket } = await baileys();
    const quote: WaQuote = { chatId: `${PHONE}@c.us`, id: 'q', fromMe: false, text: 'hi', voiceSeconds: null };
    await driver.sendVoice!(`${PHONE}@c.us`, { audio: OGG, seconds: 4, waveform: [0, 50, 100] }, { quote });
    expect(socket.sent[0].jid).toBe(`${PHONE}@s.whatsapp.net`);
    expect(socket.sent[0].content).toMatchObject({ ptt: true, mimetype: VOICE_MIMETYPE, seconds: 4 });
    expect(socket.sent[0].content.waveform).toEqual(Uint8Array.from([0, 50, 100]));
    expect(socket.sent[0].options).toEqual({
      quoted: {
        key: { remoteJid: `${PHONE}@s.whatsapp.net`, id: 'q', fromMe: false },
        message: { conversation: 'hi' },
      },
    });
  });

  it('sends a picture, a video and a file as WhatsApp media, with words under them', async () => {
    const { driver, socket } = await baileys();
    const data = Buffer.from('bytes');
    await driver.sendImage!(`${PHONE}@c.us`, { data, mimetype: 'image/png', caption: 'Sunset' });
    await driver.sendVideo!(`${PHONE}@c.us`, { data, mimetype: 'video/mp4' });
    await driver.sendDocument!(`${PHONE}@c.us`, { data, mimetype: 'application/pdf', fileName: 'Plan.pdf' });
    expect(socket.sent.map(sent => sent.content)).toEqual([
      { image: data, mimetype: 'image/png', caption: 'Sunset' },
      { video: data, mimetype: 'video/mp4' },
      { document: data, mimetype: 'application/pdf', fileName: 'Plan.pdf' },
    ]);
  });

  it('quotes a voice note as one', () => {
    expect(quotedOf({ chatId: '1@lid', id: 'v', fromMe: false, text: '', voiceSeconds: 7 }).message).toEqual({
      audioMessage: { ptt: true, seconds: 7 },
    });
  });

  it('reacts, edits and deletes by the message’s key', async () => {
    const { driver, socket } = await baileys();
    const ref: WaRef = { chatId: SELF, id: 'm', fromMe: true };
    await driver.react!(ref, '✅');
    await driver.edit!(ref, 'new words');
    await driver.remove!(ref);
    const key = { remoteJid: `${ME}@s.whatsapp.net`, id: 'm', fromMe: true };
    expect(socket.sent.map(item => item.content)).toEqual([
      { react: { text: '✅', key } },
      { text: 'new words', edit: key },
      { delete: key },
    ]);
  });

  it('comes online only while typing or recording, and goes offline after', async () => {
    const { driver, socket } = await baileys();
    await driver.presence!('1@lid', 'composing');
    await driver.presence!('1@lid', 'recording');
    await driver.presence!('1@lid', 'paused');
    expect(socket.presence).toEqual([
      { type: 'available' },
      { type: 'composing', jid: '1@lid' },
      { type: 'recording', jid: '1@lid' },
      { type: 'paused', jid: '1@lid' },
      { type: 'unavailable' },
    ]);
  });

  it('reads the id of the message his quotes', () => {
    const incoming = incomingOfBaileys(
      {
        key: { id: 'n', remoteJid: `${ME}@s.whatsapp.net`, fromMe: true },
        message: { extendedTextMessage: { text: 'delete that', contextInfo: { stanzaId: 'sent-3' } } },
        messageTimestamp: 9,
      },
      {
        jidNormalizedUser,
        isPnUser,
        normalizeMessageContent: normalizeMessageContent as never,
        getContentType: getContentType as never,
      },
    );
    expect(incoming).toMatchObject({ type: 'chat', body: 'delete that', quotedId: 'sent-3' });
  });
});
