import { describe, expect, it, vi } from 'vitest';
import { isPnUser, jidNormalizedUser } from 'baileys';
import { memoryLogger } from '../log';
import { baileysDriver } from '../whatsapp/baileys';
import type { BaileysModule } from '../whatsapp/baileys';
import type { WaEvents } from '../whatsapp/driver';
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
  async logout() {
    this.loggedOut = true;
  }
  end() {
    this.ended = true;
  }
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

  it('passes on only what just arrived, and sends to the service’s chat ids in Baileys’ form', async () => {
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
    expect(events.message).toHaveBeenCalledTimes(1);
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
    first.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    expect(first.events.disconnected).toHaveBeenCalled();
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
});
