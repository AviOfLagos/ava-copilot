import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, readThreads, sleep, waitForThread } from './harness.mjs';

/**
 * One conversation, typed or spoken: the voice screen's keyboard opens the conversation's own chat, what is typed
 * there (and pictures attached there) goes to the same Live session, Ava finds earlier chats with search_chats,
 * and a picture attached in a normal chat reaches the model as an image part.
 */

process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const scenarios = { 'zebra-invoice': [done], 'chat-image': [done], 'chat-blind': [done] };
const shots = process.env.E2E_SHOTS_DIR;

/** A real 24×24 PNG, so the panel can decode it. */
function png(r, g, b) {
  const size = 24;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buffer => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.concat(
    Array.from({ length: size }, () => Buffer.from([0, ...Array.from({ length: size }, () => [r, g, b]).flat()])),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let mock;
let extension;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avi-media-'));
  fs.writeFileSync(path.join(dir, 'receipt.png'), png(220, 60, 60));
  fs.writeFileSync(path.join(dir, 'chart.png'), png(60, 120, 220));
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
  const providers = await extension.getStorage('llm-api-keys');
  await extension.setStorage({
    'llm-api-keys': {
      providers: {
        ...providers.providers,
        gemini: { name: 'Gemini', type: 'gemini', apiKey: 'test-key', modelNames: ['gemini-3.8-flash'], createdAt: 1 },
      },
    },
    // These run on Gemini Live (the mock's): picked, since a conversation is on the device by default
    'voice-engine-settings': { mode: 'live', modeChosen: true },
    'meeting-settings': {
      liveModel: 'gemini-3.8-live',
      autoNotes: false,
      liveEndpoint: `ws://127.0.0.1:${mock.port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
    },
  });
});

after(async () => {
  await extension?.close();
  await mock?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (check, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** Reads a thread's messages straight from IndexedDB. */
const readMessages = (page, threadId) =>
  page.evaluate(
    threadId =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('messages').objectStore('messages').getAll();
          all.onsuccess = () =>
            resolve(
              all.result
                .filter(message => message.threadId === threadId)
                .sort((a, b) => a.seq - b.seq)
                .map(message => ({
                  actor: message.actor,
                  content: message.content,
                  attachments: (message.attachments ?? []).map(item => ({ name: item.name, kind: item.kind })),
                })),
            );
          all.onerror = () => reject(all.error);
        };
      }),
    threadId,
  );

/** Says what the provider reports the mock model can do: with `image`, it can see pictures. */
const setCatalog = (page, modalities) =>
  page.evaluate(
    modalities =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const store = open.result.transaction('modelCatalog', 'readwrite').objectStore('modelCatalog');
          const request = modalities
            ? store.put({
                id: 'mock:scripted',
                providerId: 'mock',
                model: 'scripted',
                label: 'scripted',
                local: false,
                contextTokens: null,
                inputUsdPerM: null,
                outputUsdPerM: null,
                modalities,
                tools: true,
                health: 'ok',
              })
            : store.delete('mock:scripted');
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        };
      }),
    modalities,
  );

/** Attaches files through the composer's file picker and waits for their thumbnails. */
async function attach(panel, ...names) {
  const input = await panel.$('form input[type="file"]');
  await input.uploadFile(...names.map(name => path.join(dir, name)));
  await panel.waitForFunction(
    count => document.querySelectorAll('ul[aria-label="Attached pictures and videos"] img').length >= count,
    { polling: 300, timeout: 10000 },
    names.length,
  );
}

async function typeAndSend(session, text) {
  await session.panel.evaluate(text => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(200);
  await session.click('Send');
}

test('during a voice session the keyboard opens the same conversation, and typing and pictures go to it', async () => {
  // An earlier chat, for Ava to find
  mock.start('zebra-invoice');
  const session = await openSession(extension, mock);
  await session.send('Run the scripted scenario zebra-invoice: check the zebra invoice total');
  await waitForThread(session.panel, 'zebra-invoice', thread => thread.status === 'idle');

  // Ava is asked about it out loud and searches the chats
  mock.live.voiceRequest = 'What did we find about the zebra invoice?';
  mock.live.voiceTool = { name: 'search_chats', args: { query: 'zebra invoice' } };
  await session.click('New chat').catch(() => {});
  await session.web.bringToFront();
  await session.click('Talk to Ava');
  await waitFor(() => mock.live.sessions.some(s => s.voice), 'a voice session');
  const voiceIndex = mock.live.sessions.findIndex(s => s.voice);
  await waitFor(() => mock.live.toolResponses.length > 0, 'the search_chats result');
  const found = JSON.stringify(mock.live.toolResponses[0].response);
  assert.match(found, /zebra-invoice/);
  assert.match(found, /nano_untrusted_content/);

  // The keyboard opens the conversation's own chat, not a new one
  const before = (await readThreads(session.panel)).length;
  await session.panel.bringToFront();
  await session.click('Type in this conversation');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Back to voice'), {
    polling: 300,
    timeout: 10000,
  });
  const voiceThread = (await readThreads(session.panel)).find(t => t.tags.includes('voice'));
  assert.ok(voiceThread);
  assert.match(await session.panelText(), /Voice conversation/);
  assert.match(await session.panelText(), /is listening\. What you type here goes to the same conversation/);

  // A typed message reaches the same Live session, and the answer is written in the chat
  await typeAndSend(session, 'Also note the due date please');
  await waitFor(() => mock.live.typed.length > 0, 'the typed turn');
  assert.equal(mock.live.typed[0].session, voiceIndex);
  assert.match(mock.live.typed[0].text, /Also note the due date please/);
  await waitFor(
    async () => (await readMessages(session.panel, voiceThread.id)).some(m => m.content === 'Got your message.'),
    'the answer in the chat',
  );

  // A picture attached there reaches the Live session as inline data
  await attach(session.panel, 'receipt.png');
  await typeAndSend(session, 'What is on this receipt?');
  await waitFor(() => mock.live.typed.length > 1, 'the typed turn with a picture');
  assert.equal(mock.live.typed[1].session, voiceIndex);
  assert.deepEqual(mock.live.typed[1].mimeTypes, ['image/png']);
  const messages = await readMessages(session.panel, voiceThread.id);
  const withPicture = messages.find(m => m.content === 'What is on this receipt?');
  assert.deepEqual(withPicture.attachments, [{ name: 'receipt.png', kind: 'image' }]);
  // No other chat was made for any of this
  assert.equal((await readThreads(session.panel)).length, before);

  if (shots) {
    await session.panel.setViewport({ width: 400, height: 760 });
    await sleep(600);
    await session.panel.screenshot({ path: path.join(shots, 'voice-thread.png') });
  }

  // Back to the full voice screen
  await session.click('Back to voice');
  await session.panel.waitForSelector('section[aria-label]', { timeout: 5000 });
  await session.click('Stop talking');
  mock.live.voiceTool = undefined;
  await session.close();
});

test('a picture attached in a normal chat reaches the model as an image part, or is plainly refused', async () => {
  mock.start('chat-image');
  const session = await openSession(extension, mock);
  await setCatalog(session.panel, ['chat', 'text', 'image']);
  await attach(session.panel, 'receipt.png', 'chart.png');
  if (shots) {
    await session.panel.setViewport({ width: 400, height: 760 });
    await session.panel.bringToFront();
    await sleep(600);
    await session.panel.screenshot({ path: path.join(shots, 'composer-attachments.png') });
  }
  await typeAndSend(session, 'Run the scripted scenario chat-image: read these');
  await session.waitForEnd();
  assert.ok(mock.runs.get('chat-image').attachedImages[0] >= 2, 'both pictures reach the navigator');
  const thread = await waitForThread(session.panel, 'chat-image');
  const [request] = (await readMessages(session.panel, thread.id)).filter(m => m.actor === 'user');
  assert.equal(request.attachments.length, 2);
  // The thread shows them
  await session.panel.waitForSelector('img[alt="receipt.png"]', { timeout: 5000 });
  await session.close();

  // A model that cannot see: the task runs on the words, and the chat says why
  mock.start('chat-blind');
  const blind = await openSession(extension, mock);
  await setCatalog(blind.panel, ['chat', 'text']);
  await attach(blind.panel, 'chart.png');
  await typeAndSend(blind, 'Run the scripted scenario chat-blind: read this');
  await blind.waitForEnd();
  assert.equal(mock.runs.get('chat-blind').attachedImages[0], 0);
  assert.match(await blind.panelText(), /can't look at pictures/);
  await blind.close();
});
