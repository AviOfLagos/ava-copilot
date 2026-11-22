import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getContentType, isPnUser, jidNormalizedUser, normalizeMessageContent } from 'baileys';
import { memoryLogger } from '../log';
import { incomingOfBaileys } from '../whatsapp/baileys';
import type { WaDriver, WaEvents, WaIncoming, WaRef } from '../whatsapp/driver';
import { OWN_MARK, WhatsAppService } from '../whatsapp/service';
import { startTestBrain, tempDir } from './helpers';

// Tasks on WhatsApp (docs/pm-desk.md, Part 8), the Ava Brain half: a send says which message went out, and the
// owner's reactions reach the extension through the same owner check as his words, nobody else's. Made-up numbers.

const ME = '2348011111111';
const SELF = `${ME}@c.us`;
const OWNER = '2348022222222';
const FRIEND = '2348099999999';

class FakeDriver implements WaDriver {
  events: WaEvents | null = null;
  sent: { chatId: string; text: string; id: string }[] = [];
  reacted: { ref: WaRef; emoji: string }[] = [];
  private next = 0;
  async start(events: WaEvents) {
    this.events = events;
  }
  async sendText(chatId: string, text: string) {
    const id = `sent-${++this.next}`;
    this.sent.push({ chatId, text: text.replaceAll(OWN_MARK, ''), id });
    return id;
  }
  async react(ref: WaRef, emoji: string) {
    this.reacted.push({ ref, emoji });
  }
  async stop() {}
  link() {
    this.events!.ready({ number: ME, selfIds: [SELF] });
  }
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
  /** A reaction as the service gets it from the driver. */
  reactTo(targetId: string, emoji: string, message: Partial<WaIncoming> = {}) {
    this.deliver({ type: 'reaction', body: '', reaction: { targetId, emoji }, ...message });
  }
}

const dirs: { remove: () => void }[] = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.remove();
});

async function linked(options: { owner?: string } = {}) {
  const dir = tempDir();
  dirs.push(dir);
  let now = 1_000_000;
  const driver = new FakeDriver();
  const log = memoryLogger();
  const service = new WhatsAppService({
    dataDir: dir.path,
    log,
    driver: () => driver,
    findBrowser: () => null,
    now: () => now,
  });
  await service.init();
  service.setQuietHours('00:00', '00:00');
  await service.link();
  driver.link();
  if (options.owner) service.setOwner(options.owner);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const kept = () => readFileSync(join(dir.path, 'whatsapp', 'state.json'), 'utf8');
  return { driver, service, log, settle, kept, advance: (ms: number) => (now += ms) };
}

const lib = {
  jidNormalizedUser,
  isPnUser,
  normalizeMessageContent: normalizeMessageContent as never,
  getContentType: getContentType as never,
};

describe('a send says which message went out', () => {
  it('returns the id of the message the client sent', async () => {
    const { driver, service } = await linked();
    const { messageId } = await service.send({ text: '1. Send the deck to Ada', kind: 'tasks' });
    expect(messageId).toBe('sent-1');
    expect(driver.sent).toEqual([{ chatId: SELF, text: '1. Send the deck to Ada', id: 'sent-1' }]);
  });

  it('holds a task list in quiet hours like any notice, while an answer still goes', async () => {
    const { service } = await linked();
    service.setQuietHours('00:00', '23:59');
    await expect(service.send({ text: '1. A task', kind: 'tasks' })).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(service.send({ text: 'Done: A task', kind: 'reply' })).resolves.toMatchObject({
      messageId: expect.any(String),
    });
  });

  it('stamps a message that waited with the time he wrote it, so "done 2" is read against the lists he had seen', async () => {
    const { driver, service, settle, advance } = await linked();
    // He writes at 1 060 000 ms (WhatsApp counts seconds); the Mac only gets it ten minutes later
    advance(600_000);
    driver.deliver({ id: 'late', body: 'done 2', at: 1_060 });
    // One that comes at once keeps the Mac's own moment, so its clock and WhatsApp's never disagree
    driver.deliver({ id: 'now', body: 'done 1', at: 1_600 });
    await settle();
    expect(service.pull().map(({ id, at }) => ({ id, at }))).toEqual([
      { id: 'late', at: 1_060_000 },
      { id: 'now', at: 1_600_000 },
    ]);
  });

  it('the route answers with the message id and the inbox carries reactions apart from messages', async () => {
    const driver = new FakeDriver();
    const brain = await startTestBrain({ whatsappDriver: () => driver });
    try {
      await brain.pair();
      await brain.api('/v1/whatsapp/quiet', { body: JSON.stringify({ quietStart: '00:00', quietEnd: '00:00' }) });
      await brain.api('/v1/whatsapp/link');
      driver.link();
      const sent = await brain.api('/v1/whatsapp/send', {
        body: JSON.stringify({ requestId: 'request-0001', text: '1. A task', kind: 'tasks' }),
      });
      expect(await sent.json()).toMatchObject({ ok: true, messageId: 'sent-1' });
      driver.reactTo('sent-1', '✅', { id: 'r-1' });
      await new Promise(resolve => setTimeout(resolve, 0));
      const inbox = (await (await brain.api('/v1/whatsapp/inbox')).json()) as {
        messages: unknown[];
        reactions: { id: string; targetId: string; emoji: string }[];
      };
      expect(inbox.messages).toEqual([]);
      expect(inbox.reactions).toEqual([{ id: 'r-1', targetId: 'sent-1', emoji: '✅', at: expect.any(Number) }]);
      await brain.api('/v1/whatsapp/ack', { body: JSON.stringify({ ids: ['r-1'] }) });
      const after = (await (await brain.api('/v1/whatsapp/inbox')).json()) as { reactions: unknown[] };
      expect(after.reactions).toEqual([]);
    } finally {
      await brain.stop();
    }
  });
});

describe('the owner’s reactions, and nobody else’s', () => {
  it('passes on his reaction in his own chat, and its removal', async () => {
    const { driver, service, settle } = await linked();
    driver.reactTo('sent-1', '✅', { id: 'r-1' });
    driver.reactTo('sent-1', '', { id: 'r-2' });
    await settle();
    expect(service.pullReactions()).toEqual([
      { id: 'r-1', targetId: 'sent-1', emoji: '✅', at: expect.any(Number) },
      { id: 'r-2', targetId: 'sent-1', emoji: '', at: expect.any(Number) },
    ]);
    // Not words to answer
    expect(service.pull()).toEqual([]);
  });

  it('passes on his reaction from his own number when Ava has hers, through the same check as his words', async () => {
    const { driver, service, settle } = await linked({ owner: OWNER });
    driver.reactTo('sent-1', '👍', { id: 'r-1', chatId: `${OWNER}@c.us`, fromMe: false });
    // His number behind a @lid id, shown on the message
    driver.reactTo('sent-2', '✅', { id: 'r-2', chatId: '7777@lid', fromMe: false, senderNumber: OWNER });
    await settle();
    expect(service.pullReactions().map(item => item.id)).toEqual(['r-1', 'r-2']);
  });

  it('drops a reaction from any other person or chat before anything about it is kept', async () => {
    const { driver, service, settle, kept, log } = await linked({ owner: OWNER });
    // A friend reacting on a message of Ava's in his own chat with her
    driver.reactTo('sent-1', '✅', { id: 'friend-r', chatId: `${FRIEND}@c.us`, fromMe: false });
    // In a group
    driver.reactTo('sent-1', '✅', { id: 'group-r', chatId: '1234567890-1@g.us', fromMe: false, isGroup: true });
    // A @lid chat that is not shown to be his
    driver.reactTo('sent-1', '✅', { id: 'lid-r', chatId: '8888@lid', fromMe: false, senderNumber: FRIEND });
    driver.reactTo('sent-1', '✅', { id: 'lid-unknown', chatId: '9999@lid', fromMe: false });
    // The linked account reacting in his chat is Ava, not him
    driver.reactTo('sent-1', '✅', { id: 'ava-r', chatId: `${OWNER}@c.us`, fromMe: true });
    // A status and a channel
    driver.reactTo('sent-1', '✅', { id: 'status-r', chatId: 'status@broadcast', fromMe: false });
    driver.reactTo('sent-1', '✅', { id: 'news-r', chatId: '123@newsletter', fromMe: false });
    // Someone else's reaction in the self chat cannot happen: a message there not from the account is dropped too
    driver.reactTo('sent-1', '✅', { id: 'self-not-me', chatId: SELF, fromMe: false });
    await settle();
    expect(service.pullReactions()).toEqual([]);
    expect(service.pull()).toEqual([]);
    const state = kept();
    for (const word of ['friend-r', 'group-r', 'lid-r', 'lid-unknown', 'ava-r', 'status-r', 'news-r', 'self-not-me']) {
      expect(state).not.toContain(word);
    }
    expect(state).not.toContain(FRIEND);
    expect(state).not.toContain('8888@lid');
    expect(log.lines.join('\n')).not.toContain('sent-1');
  });

  it('drops a reaction once the chat stops being his', async () => {
    const { driver, service, settle } = await linked({ owner: OWNER });
    driver.reactTo('sent-1', '✅', { id: 'r-1', chatId: `${OWNER}@c.us`, fromMe: false });
    await settle();
    service.setOwner(FRIEND);
    expect(service.pullReactions()).toEqual([]);
  });

  it('never takes her own reaction coming back in the self chat for his, nor history, nor a repeat', async () => {
    const { driver, service, settle, advance } = await linked();
    driver.deliver({ id: 'his-1', body: 'what is on today?' });
    await settle();
    await service.react({ emoji: '👍', messageId: 'his-1' });
    expect(driver.reacted).toEqual([{ ref: { chatId: SELF, id: 'his-1', fromMe: true }, emoji: '👍' }]);
    // WhatsApp shows it back as the account's own reaction
    driver.reactTo('his-1', '👍', { id: 'echo-1' });
    // Synced history from before the session
    driver.reactTo('sent-9', '✅', { id: 'old', at: 1 });
    driver.reactTo('sent-1', '✅', { id: 'r-1' });
    driver.reactTo('sent-1', '✅', { id: 'r-1' });
    await settle();
    expect(service.pullReactions().map(item => item.id)).toEqual(['r-1']);
    // Long after, the same emoji from him on that message is his
    advance(11 * 60_000);
    driver.reactTo('his-1', '👍', { id: 'later' });
    await settle();
    expect(service.pullReactions().map(item => item.id)).toEqual(['r-1', 'later']);
  });
});

describe('reading a Baileys reaction', () => {
  it('names the message it is on and the emoji, empty when taken back', () => {
    const key = { id: 'R1', remoteJid: `${ME}@s.whatsapp.net`, fromMe: true };
    const on = incomingOfBaileys(
      { key, message: { reactionMessage: { key: { id: 'SENT1', fromMe: true }, text: '✅' } }, messageTimestamp: 5 },
      lib,
    );
    expect(on).toMatchObject({
      id: 'R1',
      chatId: SELF,
      type: 'reaction',
      body: '',
      reaction: { targetId: 'SENT1', emoji: '✅' },
    });
    const off = incomingOfBaileys(
      { key, message: { reactionMessage: { key: { id: 'SENT1' }, text: '' } }, messageTimestamp: 5 },
      lib,
    );
    expect(off.reaction).toEqual({ targetId: 'SENT1', emoji: '' });
    // One that names no message is WhatsApp's own bookkeeping
    const none = incomingOfBaileys({ key, message: { reactionMessage: { text: '✅' } }, messageTimestamp: 5 }, lib);
    expect(none.type).toBe('system');
  });
});
