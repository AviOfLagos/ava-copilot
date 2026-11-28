import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppearanceStore } from '../appearance-store';
import { BrainClient, BrainError, brainLocation } from '../brain';
import { checkText, isChatId } from '../validate';

const STATUS = {
  ok: true,
  version: '0.1.0',
  uptimeMs: 1,
  browserOpen: true,
  whatsapp: 'linked',
  queued: 0,
  lastSeq: 3,
};

function fakeFetch(answers: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe('brainLocation', () => {
  it("follows Ava Brain's own variables", () => {
    expect(brainLocation({}, '/Users/me')).toEqual({
      base: 'http://127.0.0.1:47615',
      tokenPath: '/Users/me/Library/Application Support/Avi Brain/desktop.token',
    });
    expect(brainLocation({ AVI_BRAIN_PORT: '48000', AVI_BRAIN_HOME: '/tmp/b' }, '/x')).toEqual({
      base: 'http://127.0.0.1:48000',
      tokenPath: '/tmp/b/desktop.token',
    });
  });
});

describe('BrainClient', () => {
  const location = { base: 'http://127.0.0.1:1', tokenPath: '/nowhere' };

  it('sends the token with no Origin, and reads the token again once when Ava Brain restarted', async () => {
    const tokens = ['old', 'new'];
    const { fetcher, calls } = fakeFetch([
      { status: 401, body: { ok: false, error: { message: 'Not allowed.' } } },
      { status: 200, body: STATUS },
    ]);
    const client = new BrainClient({ location, fetch: fetcher, readToken: async () => tokens.shift()! });
    expect((await client.status()).lastSeq).toBe(3);
    const headers = calls.map(call => call.init.headers as Record<string, string>);
    expect(headers.map(header => header.Authorization)).toEqual(['Bearer old', 'Bearer new']);
    expect(headers.every(header => !('Origin' in header))).toBe(true);
    expect(calls[0].url).toBe('http://127.0.0.1:1/desktop/v1/status');
  });

  it('says Ava Brain is off when there is no token or nothing listens', async () => {
    const noToken = new BrainClient({ location, readToken: async () => Promise.reject(new Error('ENOENT')) });
    await expect(noToken.status()).rejects.toMatchObject({ kind: 'off' });
    const nothing = new BrainClient({
      location,
      readToken: async () => 't',
      fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
    });
    await expect(nothing.status()).rejects.toBeInstanceOf(BrainError);
  });

  it('says an Ava Brain without the desktop routes needs updating', async () => {
    const { fetcher } = fakeFetch([{ status: 404, body: {} }]);
    const client = new BrainClient({ location, fetch: fetcher, readToken: async () => 't' });
    await expect(client.status()).rejects.toThrow('older than the app');
  });

  it('sends a message with a request id', async () => {
    const { fetcher, calls } = fakeFetch([{ status: 200, body: { ok: true, id: 'dm_1', browserOpen: false } }]);
    const client = new BrainClient({
      location,
      fetch: fetcher,
      readToken: async () => 't',
      newRequestId: () => 'req-12345',
    });
    await client.send('dc_abcdefgh12', 'hi');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      requestId: 'req-12345',
      chatId: 'dc_abcdefgh12',
      text: 'hi',
    });
  });
});

describe('BrainClient.replies', () => {
  const location = { base: 'http://127.0.0.1:1', tokenPath: '/nowhere' };
  const answer = (seq: number) => ({ seq, chatId: 'dc_abcdefgh12', kind: 'answer', text: `a${seq}`, at: seq });

  it('reads from the start again when Ava Brain restarted and its numbers went back', async () => {
    const { fetcher, calls } = fakeFetch([
      { status: 200, body: { ok: true, replies: [], browserOpen: true, lastSeq: 2 } },
      { status: 200, body: { ok: true, replies: [answer(1), answer(2)], browserOpen: true, lastSeq: 2 } },
    ]);
    const client = new BrainClient({ location, fetch: fetcher, readToken: async () => 't' });
    const read = await client.replies(57);
    expect(read).toMatchObject({ restarted: true });
    expect(read.replies.map(reply => reply.seq)).toEqual([1, 2]);
    expect(calls.map(call => JSON.parse(call.init.body as string).after)).toEqual([57, 0]);
  });

  it('reads on from its place otherwise', async () => {
    const { fetcher } = fakeFetch([
      { status: 200, body: { ok: true, replies: [answer(4)], browserOpen: true, lastSeq: 4 } },
    ]);
    const client = new BrainClient({ location, fetch: fetcher, readToken: async () => 't' });
    expect(await client.replies(3)).toMatchObject({ restarted: false, replies: [{ seq: 4 }] });
  });
});

describe('what the window sends', () => {
  it('takes only conversation ids and words within the limit', () => {
    expect(isChatId('dc_abcdefgh12')).toBe(true);
    expect(isChatId('../etc')).toBe(false);
    expect(checkText('  hi  ')).toBe('hi');
    expect(checkText('   ')).toBeNull();
    expect(checkText(42)).toBeNull();
    expect(checkText('x'.repeat(20_001))).toBeNull();
  });
});

describe('AppearanceStore', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps the same record as the extension, repaired on read', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ava-desktop-'));
    const path = join(dir, 'appearance.json');
    const store = new AppearanceStore(path);
    expect(await store.get()).toEqual({ theme: 'dark', textScale: 100, density: 'comfortable' });
    await Promise.all([store.update({ textScale: 120 }), store.update({ theme: 'light' })]);
    expect(await store.get()).toEqual({ theme: 'light', textScale: 120, density: 'comfortable' });
    writeFileSync(path, JSON.stringify({ theme: 'neon', textScale: 104, density: 'roomy' }));
    expect(await store.get()).toEqual({ theme: 'dark', textScale: 100, density: 'roomy' });
  });
});
