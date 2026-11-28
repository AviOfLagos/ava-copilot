import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DESKTOP_ROUTES, DESKTOP_TOKEN_FILE, desktopStatusSchema } from '@protocol';
import { DESKTOP_QUEUE_MAX, DesktopChannel } from '../desktop/channel';
import { startTestBrain } from './helpers';

const CHAT = 'dc_abcdefgh12';

describe('DesktopChannel', () => {
  it("hands the window's words to the extension once, and the answers back in order", () => {
    let now = 1_000;
    const channel = new DesktopChannel(() => now);
    expect(channel.browserOpen()).toBe(false);
    channel.send(CHAT, 'hello');
    channel.send(CHAT, 'and this');
    expect(channel.queued).toBe(2);
    const waiting = channel.pending();
    expect(waiting.map(message => message.text)).toEqual(['hello', 'and this']);
    // Kept until acked
    expect(channel.pending()).toHaveLength(2);
    channel.ack(waiting.map(message => message.id));
    expect(channel.pending()).toEqual([]);
    expect(channel.browserOpen()).toBe(true);

    const first = channel.reply(CHAT, 'working', '');
    channel.reply(CHAT, 'answer', 'Hi');
    expect(channel.repliesAfter(0).map(reply => reply.kind)).toEqual(['working', 'answer']);
    expect(channel.repliesAfter(first.seq).map(reply => reply.text)).toEqual(['Hi']);
    expect(channel.lastSeq).toBe(2);

    now += 60_000;
    expect(channel.browserOpen()).toBe(false);
  });

  it('keeps only the newest messages when the browser stays closed', () => {
    const channel = new DesktopChannel();
    for (let i = 0; i < DESKTOP_QUEUE_MAX + 5; i++) channel.send(CHAT, `m${i}`);
    const taken = channel.pending();
    expect(taken).toHaveLength(DESKTOP_QUEUE_MAX);
    expect(taken[0].text).toBe('m5');
  });
});

describe('desktop routes', () => {
  let test: Awaited<ReturnType<typeof startTestBrain>>;
  afterEach(async () => test?.stop());

  const desktop = (path: string, token: string | null, body: unknown = {}, origin?: string) =>
    test.api(path, { method: 'POST', origin: origin ?? null, token, body: JSON.stringify(body) });

  it('writes the token for this user only, and answers the app with it and no Origin', async () => {
    test = await startTestBrain();
    const file = join(test.brain.config.dataDir, DESKTOP_TOKEN_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const token = readFileSync(file, 'utf8').trim();
    expect(token).toBe(test.brain.desktopToken);

    const status = await desktop(DESKTOP_ROUTES.status, token);
    expect(status.status).toBe(200);
    const parsed = desktopStatusSchema.parse(await status.json());
    expect(parsed).toMatchObject({ browserOpen: false, whatsapp: 'not_linked', queued: 0, lastSeq: 0 });

    // A web page (any Origin, the extension's included) and a wrong or missing token are refused
    expect((await desktop(DESKTOP_ROUTES.status, token, {}, 'https://evil.example')).status).toBe(403);
    expect((await test.api(DESKTOP_ROUTES.status, { method: 'POST', token, body: '{}' })).status).toBe(403);
    expect((await desktop(DESKTOP_ROUTES.status, 'x'.repeat(43))).status).toBe(401);
    expect((await desktop(DESKTOP_ROUTES.status, null)).status).toBe(401);
  });

  it('passes a message from the app to the paired extension and its answer back', async () => {
    test = await startTestBrain();
    const token = test.brain.desktopToken;
    // The extension's routes need pairing
    expect((await test.api(DESKTOP_ROUTES.inbox, { token: null })).status).toBe(401);
    await test.pair();

    const sent = await desktop(DESKTOP_ROUTES.send, token, { requestId: 'req-00001', chatId: CHAT, text: 'Hello Ava' });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ ok: true, browserOpen: false });
    // A repeated requestId is not a second message
    await desktop(DESKTOP_ROUTES.send, token, { requestId: 'req-00001', chatId: CHAT, text: 'Hello Ava' });
    // The app cannot read the extension's queue
    expect((await desktop(DESKTOP_ROUTES.inbox, token)).status).toBe(403);

    const inbox = (await (await test.api(DESKTOP_ROUTES.inbox)).json()) as { messages: { id: string; text: string }[] };
    expect(inbox.messages.map(message => message.text)).toEqual(['Hello Ava']);
    await test.api(DESKTOP_ROUTES.ack, { body: JSON.stringify({ ids: inbox.messages.map(message => message.id) }) });
    const after = (await (await test.api(DESKTOP_ROUTES.inbox)).json()) as { messages: unknown[] };
    expect(after.messages).toEqual([]);

    const reply = await test.api(DESKTOP_ROUTES.reply, {
      body: JSON.stringify({ requestId: 'req-00002', chatId: CHAT, kind: 'answer', text: 'Hi there' }),
    });
    expect(reply.status).toBe(200);

    const read = (await (await desktop(DESKTOP_ROUTES.messages, token, { after: 0 })).json()) as {
      replies: { kind: string; text: string }[];
      browserOpen: boolean;
      lastSeq: number;
    };
    expect(read.lastSeq).toBe(1);
    expect(read.replies).toMatchObject([{ kind: 'answer', text: 'Hi there' }]);
    expect(read.browserOpen).toBe(true);

    expect(
      (await desktop(DESKTOP_ROUTES.send, token, { requestId: 'req-00003', chatId: 'nope', text: 'x' })).status,
    ).toBe(400);
  });
});
