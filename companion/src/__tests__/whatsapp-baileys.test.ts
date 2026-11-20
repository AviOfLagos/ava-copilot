import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getContentType, isPnUser, jidNormalizedUser, normalizeMessageContent } from 'baileys';
import { memoryLogger } from '../log';
import { baileysDriver, readCapped } from '../whatsapp/baileys';
import type { BaileysModule } from '../whatsapp/baileys';
import type { WaEvents, WaIncoming } from '../whatsapp/driver';
import { tempDir } from './helpers';

// Baileys is never connected to WhatsApp here: a stand-in socket replays what it would emit
class FakeSocket {
  listeners = new Map<string, (payload: unknown) => void>();
  user: { id: string; lid?: string } | null = null;
  sent: { jid: string; text: string }[] = [];
  ended = false;
  loggedOut = false;
  ev = { on: (event: string, listener: (payload: unknown) => void) => void this.listeners.set(event, listener) };
  emit(event: string, payload: unknown) {
    this.listeners.get(event)?.(payload);
  }
  async sendMessage(jid: string, content: { text: string }) {
    this.sent.push({ jid, text: content.text });
    return { key: { id: `sent-${this.sent.length}` } };
  }
  reuploads = 0;
  async updateMediaMessage(message: unknown) {
    this.reuploads++;
    return message;
  }
  async logout() {
    this.loggedOut = true;
  }
  end() {
    this.ended = true;
  }
}

// What WhatsApp's media server hands back for a file: these chunks, or an expired link the first time
const files = new Map<string, { chunks: Buffer[]; expiredOnce?: boolean }>();

async function* chunksOf(list: Buffer[]) {
  for (const chunk of list) yield chunk;
}

function harness() {
  const sockets: FakeSocket[] = [];
  const creds: { me?: unknown } = {};
  const lib: BaileysModule = {
    makeWASocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as ReturnType<BaileysModule['makeWASocket']>;
    },
    useMultiFileAuthState: async () => ({ state: { creds }, saveCreds: async () => {} }),
    jidNormalizedUser,
    isPnUser,
    normalizeMessageContent: normalizeMessageContent as never,
    getContentType: getContentType as never,
    downloadMediaMessage: async (message, _type, _options, ctx) => {
      const file = files.get(message.key.id ?? '');
      if (!file) throw new Error('not media');
      if (file.expiredOnce) {
        file.expiredOnce = false;
        await ctx.reuploadRequest(message);
      }
      return chunksOf(file.chunks);
    },
    Browsers: { macOS: name => ['Mac OS', name, '14'] },
  };
  const events = {
    qr: vi.fn(),
    ready: vi.fn(),
    disconnected: vi.fn(),
    failed: vi.fn(),
    message: vi.fn(),
  } satisfies WaEvents;
  const dir = tempDir();
  const driver = baileysDriver(memoryLogger(), async () => lib)({ sessionDir: dir.path, executablePath: null });
  return { driver, events, sockets, creds, dir };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Baileys driver', () => {
  it('shows the code, opens a fresh socket after the scan, and reports the linked number', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { driver, events, sockets, dir } = harness();
    await driver.start(events);
    sockets[0].emit('connection.update', { qr: '2@code' });
    expect(events.qr).toHaveBeenCalledWith('2@code');
    sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    vi.runOnlyPendingTimers();
    expect(sockets).toHaveLength(2);
    sockets[1].user = { id: '2348011111111:7@s.whatsapp.net', lid: '99999:7@lid' };
    sockets[1].emit('connection.update', { connection: 'open' });
    expect(events.ready).toHaveBeenCalledWith({
      number: '2348011111111',
      selfIds: ['2348011111111@c.us', '99999@lid'],
    });
    vi.useRealTimers();
    await driver.stop();
    expect(sockets[1].ended).toBe(true);
    dir.remove();
  });

  it('passes on what just arrived or came while offline, and sends to the service’s chat ids in Baileys’ form', async () => {
    const { driver, events, sockets, dir } = harness();
    await driver.start(events);
    sockets[0].emit('messages.upsert', {
      type: 'append',
      messages: [{ key: { id: 'old', remoteJid: '1@lid' }, message: { conversation: 'old' } }],
    });
    sockets[0].emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { id: 'new', remoteJid: '1@lid', remoteJidAlt: '2348022222222@s.whatsapp.net' },
          message: { conversation: 'Hi' },
          messageTimestamp: 9,
        },
      ],
    });
    // Delivered on reconnect: what he sent while the line was down comes as 'append' too; her own sends do not count
    sockets[0].emit('messages.upsert', {
      type: 'append',
      messages: [
        { key: { id: 'offline', remoteJid: '1@lid', fromMe: false }, message: { conversation: 'You there?' } },
        { key: { id: 'own', remoteJid: '1@lid', fromMe: true }, message: { conversation: 'Her answer' } },
      ],
    });
    expect(events.message).toHaveBeenCalledTimes(2);
    expect(events.message.mock.calls[1][0]).toMatchObject({ id: 'offline', body: 'You there?' });
    expect(events.message.mock.calls[0][0]).toMatchObject({
      id: 'new',
      chatId: '1@lid',
      senderNumber: '2348022222222',
    });
    expect(await driver.sendText('2348022222222@c.us', 'hello')).toBe('sent-1');
    await driver.sendText('1@lid', 'there');
    expect(sockets[0].sent.map(item => item.jid)).toEqual(['2348022222222@s.whatsapp.net', '1@lid']);
    await driver.stop();
    dir.remove();
  });

  it('says so when the phone removed this Mac, and gives up on a code nobody scanned', async () => {
    const first = harness();
    await first.driver.start(first.events);
    // The login WhatsApp just refused for good
    const authDir = join(first.dir.path, 'baileys');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'creds.json'), '{}');
    first.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    expect(first.events.disconnected).toHaveBeenCalledWith(expect.stringMatching(/Relink/));
    // Gone, so Relink shows a new code instead of being refused again
    expect(existsSync(authDir)).toBe(false);
    await tick();
    expect(first.sockets).toHaveLength(1);
    first.dir.remove();

    const second = harness();
    await second.driver.start(second.events);
    second.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    expect(second.events.failed).toHaveBeenCalled();
    second.dir.remove();
  });

  it('logs out of the phone on request', async () => {
    const { driver, events, sockets, dir } = harness();
    await driver.start(events);
    await driver.logout!();
    expect(sockets[0].loggedOut).toBe(true);
    await driver.stop();
    dir.remove();
  });

  it('reads a voice note’s details and fetches its file only when asked, capped', async () => {
    const { driver, events, sockets, dir } = harness();
    await driver.start(events);
    files.set('voice', { chunks: [Buffer.from('Ogg'), Buffer.from('S-opus')], expiredOnce: true });
    sockets[0].emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { id: 'voice', remoteJid: '2348011111111@s.whatsapp.net', fromMe: true },
          message: {
            audioMessage: {
              mimetype: 'audio/ogg; codecs=opus',
              fileLength: { toNumber: () => 9 },
              seconds: 4,
              ptt: true,
            },
          },
          messageTimestamp: 9,
        },
      ],
    });
    const incoming = events.message.mock.calls[0][0] as WaIncoming;
    expect(incoming).toMatchObject({
      type: 'audio',
      body: '',
      media: { mediaType: 'audio/ogg; codecs=opus', size: 9, seconds: 4, voiceNote: true, name: null },
    });
    // An expired copy is asked for again from the phone
    expect((await incoming.download!(100)).toString()).toBe('OggS-opus');
    expect(sockets[0].reuploads).toBe(1);
    await expect(incoming.download!(5)).rejects.toThrow(/larger/);
    await driver.stop();
    dir.remove();
  });

  it('gives no download to a text message, and reads a link’s preview and a document’s caption', async () => {
    const { driver, events, sockets, dir } = harness();
    await driver.start(events);
    sockets[0].emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { id: 'link', remoteJid: '2348011111111@s.whatsapp.net', fromMe: true },
          message: {
            extendedTextMessage: {
              text: 'read this https://example.com/post',
              matchedText: 'https://example.com/post',
              title: 'A post',
              description: 'About solar',
            },
          },
        },
        {
          key: { id: 'doc', remoteJid: '2348011111111@s.whatsapp.net', fromMe: true },
          message: {
            documentWithCaptionMessage: {
              message: {
                documentMessage: {
                  caption: 'what does page 2 say?',
                  fileName: 'report.pdf',
                  mimetype: 'application/pdf',
                  fileLength: 2048,
                },
              },
            },
          },
        },
      ],
    });
    const [link, doc] = events.message.mock.calls.map(call => call[0] as WaIncoming);
    expect(link).toMatchObject({
      type: 'chat',
      link: { url: 'https://example.com/post', title: 'A post', description: 'About solar' },
    });
    expect(link.download).toBeUndefined();
    expect(doc).toMatchObject({
      type: 'document',
      body: 'what does page 2 say?',
      media: { name: 'report.pdf', mediaType: 'application/pdf', size: 2048 },
    });
    expect(typeof doc.download).toBe('function');
    await driver.stop();
    dir.remove();
  });

  it('stops reading a file as soon as it passes the cap', async () => {
    let destroyed = false;
    const stream = Object.assign(chunksOf([Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)]), {
      destroy: () => {
        destroyed = true;
      },
    });
    await expect(readCapped(stream, 6)).rejects.toThrow(/larger/);
    expect(destroyed).toBe(true);
    expect((await readCapped(chunksOf([Buffer.from('ab')]), 6)).toString()).toBe('ab');
  });
});
