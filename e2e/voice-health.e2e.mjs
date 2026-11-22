import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end test of the voice presets and the slow-voice fallback: Settings › Voice lists the presets with what each
 * still needs, "Check this computer" times the downloaded voice in the real offscreen document and keeps the speed, and
 * an answer read aloud with a voice measured slower than speech is spoken by the computer's own voice instead, with a
 * line in the voice trace and one in the Inbox. Needs the models: node scripts/voice-models-setup.mjs, then pnpm build.
 */

const root = path.resolve(import.meta.dirname, '..');
const manifestFile = path.join(root, 'dist/voice/manifest.json');
const components = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')).components : null;
const SKIP =
  components?.kitten && components?.['moonshine-tiny']
    ? false
    : 'the build has no voice models: run node scripts/voice-models-setup.mjs, then pnpm build';
if (SKIP) console.log(`# voice-health skipped: ${SKIP}`);

let mock;
let extension;
let session;

const waitFor = async (check, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** A panel command, the way the panel's PanelApi sends one. */
function command(page, message, timeout = 120_000) {
  return page.evaluate(
    (message, timeout) =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'side-panel-connection' });
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => reject(new Error(`${message.type} timed out`)), timeout);
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
    timeout,
  );
}

/** A panel command that answers nothing (speak_say), sent and left. */
function post(page, message) {
  return page.evaluate(message => {
    const port = chrome.runtime.connect({ name: 'side-panel-connection' });
    port.postMessage({ ...message, requestId: crypto.randomUUID() });
    setTimeout(() => port.disconnect(), 500);
  }, message);
}

/** The Inbox items, straight from the extension's IndexedDB. */
function readInbox(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('inbox').objectStore('inbox').getAll();
          all.onsuccess = () => resolve(all.result.map(({ source, externalId, title, body }) => ({ source, externalId, title, body })));
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

async function backgroundWorker() {
  for (const target of extension.browser.targets()) {
    if (target.type() === 'service_worker' && target.url().startsWith(extension.origin)) return target.worker();
  }
  throw new Error('No background service worker found');
}

before(async () => {
  if (SKIP) return;
  mock = await startMockLlm({});
  extension = await launchExtension(mock);
  session = await openSession(extension, mock);
  await session.panel.bringToFront();
});

after(async () => {
  await session?.close().catch(() => {});
  await extension?.close();
  await mock?.close();
});

test('Settings › Voice: presets say what each needs, and Check this computer times the voice', { skip: SKIP }, async () => {
  // The recogniser on the processor: the check is about this computer, and a busy graphics card must not decide it
  await extension.setStorage({ 'voice-engine-settings': { sttGpu: false } });
  const panel = await extension.openSettings('#voice/engines');
  await panel.waitForSelector('[data-testid="voice-preset-instant"]', { timeout: 20_000 });
  const text = () => panel.evaluate(() => document.body.innerText);

  // Nothing measured yet: the computer's own voice is the safe start, and says so
  await panel.waitForSelector('[data-testid="voice-preset-instant-recommended"]');
  assert.match(await text(), /Not checked yet/);
  assert.match(await panel.$eval('[data-testid="voice-preset-natural-needs"]', el => el.textContent), /Kokoro[^\n]*MB/);
  assert.match(await text(), /Needs a Gemini key/);
  // The packed KittenTTS and Moonshine are here, so Light can be used and the Instant one is the safe start
  const useLight = await panel.evaluate(() => {
    const card = document.querySelector('[data-testid="voice-preset-light"]');
    return [...card.querySelectorAll('button')].find(b => b.innerText.trim() === 'Use this')?.disabled;
  });
  assert.equal(useLight, false);

  await panel.bringToFront();
  await panel.evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Check this computer').click());
  // A timer, not animation frames: a page behind another gets none
  await panel.waitForFunction(() => document.querySelector('[data-testid="voice-check-speak"]'), {
    polling: 300,
    timeout: 240_000,
  });
  const speak = await panel.$eval('[data-testid="voice-check-speak"]', el => el.textContent);
  assert.match(speak, /KittenTTS speaks at [\d.]+× real time/);
  assert.match(await panel.$eval('[data-testid="voice-check-machine"]', el => el.textContent), /\d+ processor cores/);

  const health = await extension.getStorage('voice-health');
  assert.ok(health.tts.kitten.speed > 0, 'the speed was kept');
  assert.equal(health.tts.kitten.source, 'benchmark');
  assert.ok(health.machine.cores >= 1);
  assert.ok(health.stt.moonshine?.speed > 0, 'the recogniser was timed on what the voice said');
  const trace = (await extension.getStorage('voice-trace')).entries;
  assert.ok(trace.some(entry => entry.kind === 'check' && entry.engine === 'kitten'));
  await panel.close();
});

test('a voice measured slower than speech gives way to the computer\'s own, and the Inbox says so', { skip: SKIP }, async () => {
  const worker = await backgroundWorker();
  // chrome.tts stood in for: no system voice is needed, and what it was asked to say is kept
  await worker.evaluate(() => {
    self.__said = [];
    chrome.tts.speak = (text, options) => {
      self.__said.push(text);
      setTimeout(() => options?.onEvent?.({ type: 'end' }), 20);
    };
    chrome.tts.stop = () => {};
  });
  await extension.setStorage({
    'tts-settings': { readAloud: 'always', engine: 'kitten', engineChosen: true, voice: '', rate: 1, lastSpokenMessageId: null },
    // What a loaded computer showed lately: KittenTTS at 0.4 times real time
    'voice-health': { tts: { kitten: { speed: 0.4, at: Date.now(), source: 'observed' } }, stt: {}, machine: null, checkedAt: null, lastFallback: null },
  });
  const answer =
    'I looked at the failing test and the cause is a stale cache. The fix is one line in the loader, so I would ship it today.';
  await post(session.panel, { type: 'speak_say', threadId: 'voice-health-thread', messageId: 'm1', text: answer });
  await waitFor(async () => (await worker.evaluate(() => self.__said)).length > 0, 'the system voice to speak');
  assert.match((await worker.evaluate(() => self.__said)).join(' '), /stale cache/);

  const trace = (await extension.getStorage('voice-trace')).entries;
  const fallback = trace.find(entry => entry.kind === 'fallback');
  assert.ok(fallback, 'the fallback is in the trace');
  assert.equal(fallback.engine, 'kitten');
  assert.equal(fallback.note, 'slower-than-speech');
  // Sizes and times only
  assert.doesNotMatch(JSON.stringify(trace), /stale cache/);

  await waitFor(async () => (await readInbox(session.panel)).some(item => item.externalId.startsWith('voice-slow:kitten')), 'the Inbox line');
  const item = (await readInbox(session.panel)).find(item => item.externalId.startsWith('voice-slow:kitten'));
  assert.equal(item.source, 'system');
  assert.match(item.body, /KittenTTS makes speech at 0\.4× real time/);
  assert.equal((await extension.getStorage('voice-health')).lastFallback.engine, 'kitten');

  // A short line is still said by the local voice: it is over before the slowness shows
  await worker.evaluate(() => (self.__said.length = 0));
  await post(session.panel, { type: 'speak_say', threadId: 'voice-health-thread', messageId: 'm2', text: 'Done.' });
  await sleep(1500);
  assert.deepEqual(await worker.evaluate(() => self.__said), []);
});
