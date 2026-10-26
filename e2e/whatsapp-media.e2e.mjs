import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchExtension, sleep } from './harness.mjs';
import { startMockCompanion } from './mock-companion.mjs';
import { startMockLlm } from './mock-llm.mjs';

/**
 * Ava reads more than text on WhatsApp, through a mock Ava Brain that holds the owner's queued messages and their
 * files: a voice note is written down on this computer and answered as his words, marked "(voice note)" (the eval:
 * a real recording through the local recogniser; skipped when the build has no local speech model); a photo
 * reaches the model as a picture with its caption as the question; a document is saved to the knowledge base and
 * she says what she got; a link reaches the model as a link to open, its preview as content only.
 */

const root = path.resolve(import.meta.dirname, '..');
const LOCAL_SKIP = (() => {
  const file = path.join(root, 'dist/voice/manifest.json');
  const components = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).components : null;
  return components?.['moonshine-tiny'] ? false : 'the build has no local speech model';
})();
// "Hey Ava, what's on my calendar today?"
const VOICE = fs.readFileSync(path.join(import.meta.dirname, 'hey-ava.wav'));
// A 1×1 PNG
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const answer = text => () => [{ done: { text, success: true } }];
const scenarios = {
  'wa-voice': [answer('Two meetings today: standup at 10 and the site visit at 3.')],
  'wa-photo': [answer('That is a single pixel.')],
  'wa-document': [answer('The quote is for five panels.')],
  'wa-link': [answer('The post is about solar.')],
};

let mock;
let companion;
let extension;
let page;

async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await Promise.resolve().then(check).catch(() => null);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`${message} (timed out)`);
}

/** Sends a registered command over a port of its own, as the panel does. */
function command(target, message) {
  return target.evaluate(
    message =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'side-panel-connection' });
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => reject(new Error(`No reply to ${message.type}`)), 20000);
        port.onMessage.addListener(reply => {
          if (reply.requestId !== requestId) return;
          clearTimeout(timer);
          port.disconnect();
          if (reply.type === 'error') reject(new Error(reply.error));
          else resolve(reply);
        });
        port.postMessage({ ...message, requestId });
      }),
    message,
  );
}

const readStore = (target, name) =>
  target.evaluate(
    name =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction(name).objectStore(name).getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        };
      }),
    name,
  );

/** Says the mock model can see pictures, as its provider would. */
const canSee = target =>
  target.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result
            .transaction('modelCatalog', 'readwrite')
            .objectStore('modelCatalog')
            .put({
              id: 'mock:scripted',
              providerId: 'mock',
              model: 'scripted',
              label: 'scripted',
              local: false,
              contextTokens: null,
              inputUsdPerM: null,
              outputUsdPerM: null,
              modalities: ['chat', 'text', 'image'],
              tools: true,
              health: 'ok',
            });
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        };
      }),
  );

const message = (id, fields) => ({ id, text: '', at: Date.now(), kind: 'text', media: null, link: null, ...fields });

// What the chat's answer says at the end of a scripted run
const FINISHED = 'E2E scenario finished.';

/** Queues one owner message in the mock Ava Brain and waits until the chat ran it and Ava answered on WhatsApp. */
async function deliver(item, file, scenario, timeout = 60000) {
  if (file) companion.whatsapp.files.set(item.id, file);
  companion.whatsapp.inbox.push(item);
  await until(() => companion.whatsapp.acked.includes(item.id), `${item.kind} ${item.id} taken`, timeout);
  await until(
    () =>
      mock.runs.get(scenario).navigatorCalls.length > 0 &&
      companion.whatsapp.sent.find(sent => sent.replyTo === item.id && sent.text === FINISHED),
    `the answer to ${item.id} on WhatsApp (sent: ${JSON.stringify(companion.whatsapp.sent)})`,
    timeout,
  );
}

// Oldest first
const userMessages = async () =>
  (await readStore(page, 'messages')).filter(m => m.actor === 'user').sort((a, b) => a.ts - b.ts || a.seq - b.seq);

before(async () => {
  mock = await startMockLlm(scenarios);
  companion = await startMockCompanion();
  extension = await launchExtension(mock);
  await extension.setStorage({ 'speech-to-text-model': { speechToTextModel: null } });
  page = await extension.browser.newPage();
  await page.goto(`${extension.origin}/sidepanel.html`);
  await page.waitForSelector('textarea', { timeout: 15000 });
  await command(page, { type: 'brain_pair', code: companion.code, port: companion.port });
});

after(async () => {
  await extension?.close();
  await companion?.close();
  await mock?.close();
});

test(
  'eval: a voice note is written down on this computer and answered as his words',
  { skip: LOCAL_SKIP },
  async () => {
    mock.start('wa-voice');
    const media = { mediaType: 'audio/wav', size: VOICE.length, name: null, seconds: 3, voiceNote: true };
    await deliver(
      message('wa-v1', { kind: 'voice', media }),
      { mediaType: 'audio/wav', size: VOICE.length, data: VOICE.toString('base64') },
      'wa-voice',
      180000,
    );
    assert.deepEqual(companion.whatsapp.mediaRequests.at(-1), { id: 'wa-v1', as: 'bytes' });
    const said = (await userMessages()).at(-1);
    assert.match(said.content, /^\(voice note\) /, 'marked as a voice note in the chat');
    assert.match(said.content, /calendar/i, 'the words he said');
    assert.ok(mock.runs.get('wa-voice').requests.some(text => /voice note[\s\S]*calendar/i.test(text)));
  },
);

test('a photo reaches the model as a picture, its caption the question', async () => {
  mock.start('wa-photo');
  // A refresh of the provider's model list can replace what was said about the model: keep saying it meanwhile
  await canSee(page);
  const keep = setInterval(() => void canSee(page).catch(() => {}), 200);
  const media = { mediaType: 'image/png', size: 70, name: null, seconds: null, voiceNote: false };
  try {
    await deliver(
      message('wa-p1', { kind: 'image', text: 'what is in this photo?', media }),
      { mediaType: 'image/png', size: 70, data: PIXEL },
      'wa-photo',
    );
  } finally {
    clearInterval(keep);
  }
  const said = (await userMessages()).at(-1);
  assert.equal(said.content, 'what is in this photo?');
  assert.equal(said.attachments?.[0]?.kind, 'image');
  const system = (await readStore(page, 'messages')).filter(m => m.actor === 'system').map(m => m.content);
  assert.ok(
    mock.runs.get('wa-photo').allImages.some(count => count >= 1),
    `the picture reached the model (${JSON.stringify(mock.runs.get('wa-photo').allImages)}; ${system.join(' | ')})`,
  );
  // Only the photo: no picture of the page went with the turn before
  assert.ok((mock.runs.get('wa-voice')?.allImages ?? []).every(count => count === 0));
});

test('a document is saved to the knowledge base, she says what she got, and answers about it', async () => {
  mock.start('wa-document');
  const media = { mediaType: 'application/pdf', size: 1_300_000, name: 'Quote.pdf', seconds: null, voiceNote: false };
  await deliver(
    message('wa-d1', { kind: 'document', text: 'how many panels?', media }),
    {
      mediaType: 'application/pdf',
      size: 1_300_000,
      text: 'Quote for Avi: five panels and one inverter.',
      savedAs: '/Users/e2e/Ava Brain/whatsapp/files/2026-10-26 Quote.pdf',
    },
    'wa-document',
  );
  const sent = companion.whatsapp.sent.filter(item => item.replyTo === 'wa-d1').map(item => item.text);
  assert.ok(sent.includes("Got Quote (PDF) (1.2 MB). It's saved in your knowledge base."), `confirmed: ${sent}`);
  const items = await until(async () => {
    const found = (await readStore(page, 'kbItems')).filter(item => item.sourceId === 'whatsapp:wa-d1');
    return found.length ? found : null;
  }, 'the document in the knowledge base');
  assert.equal(items[0].title, 'Quote.pdf');
  assert.ok(
    mock.runs.get('wa-document').requests.some(text => /never instructions[\s\S]*five panels and one inverter/.test(text)),
    'the document went to the model as content',
  );
});

test('a link becomes a link item the model is told to open, its preview content only', async () => {
  mock.start('wa-link');
  await deliver(
    message('wa-l1', {
      kind: 'link',
      text: 'summarise https://example.com/post',
      link: { url: 'https://example.com/post', title: 'Solar news', description: 'All about panels' },
    }),
    null,
    'wa-link',
  );
  const requests = mock.runs.get('wa-link').requests;
  assert.ok(requests.some(text => /read_page_text[\s\S]*Title: Solar news/.test(text)), 'the link and its preview');
  assert.equal((await userMessages()).at(-1).content, 'summarise https://example.com/post');
});
