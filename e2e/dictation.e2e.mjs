import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, readThreads, sleep, waitForThread } from './harness.mjs';

/**
 * Dictation in the chat box, with a recording played as the microphone: while it listens the mic is a stop
 * button and a strip shows the level and the time; Stop puts the words after what was typed; Send while
 * listening sends them as soon as they are written down; a failed transcription sends nothing; Esc drops the
 * recording without sending it anywhere.
 */

process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');

const scenarios = { dictated: [() => [{ done: { text: 'Scripted steps complete.', success: true } }]] };

let mock;
let extension;
let session;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
  // Words are written down by a Gemini model at the mock
  const keys = await extension.getStorage('llm-api-keys');
  keys.providers.gemini = {
    name: 'Gemini',
    type: 'gemini',
    apiKey: 'test',
    baseUrl: mock.baseUrl.replace(/\/v1$/, '/v1beta'),
    modelNames: ['gemini-3.8-flash'],
    createdAt: Date.now(),
  };
  await extension.setStorage({
    'llm-api-keys': keys,
    'speech-to-text-model': { speechToTextModel: { provider: 'gemini', modelName: 'gemini-3.8-flash' } },
  });
  await extension.browser.defaultBrowserContext().overridePermissions(extension.origin, ['microphone']);
  session = await openSession(extension, mock);
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const panel = () => session.panel;

const typeText = text =>
  panel().evaluate(value => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);

const press = label =>
  panel().evaluate(name => {
    const button = document.querySelector(`button[aria-label="${name}"]`);
    if (!button) throw new Error(`No button "${name}"`);
    button.click();
  }, label);

const stripStatus = () =>
  panel().evaluate(() => document.querySelector('.stt-strip')?.getAttribute('data-status') ?? null);

async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('the mic turns into a stop button and shows it is listening; Stop puts the words after what was typed', async () => {
  // Animation frames (the level meter) only run in the tab in front
  await panel().bringToFront();
  await typeText('Note:');
  await press('Start voice input');
  await waitFor(async () => (await stripStatus()) === 'listening', 'listening');

  const listening = await panel().evaluate(() => ({
    stop: !!document.querySelector('button[aria-label="Stop: the words go in the box to edit"]'),
    pill: document.querySelector('.mo-pill')?.hasAttribute('data-listening'),
    attach: !!document.querySelector('button[aria-label="Attach a text file"]'),
    textarea: !!document.querySelector('textarea'),
    send: document.querySelector('button[type="submit"]')?.getAttribute('aria-label'),
    hint: document.body.innerText.includes('Esc discards'),
  }));
  assert.deepEqual(listening, {
    stop: true,
    pill: true,
    attach: false,
    textarea: false,
    send: 'Send when transcribed',
    hint: true,
  });

  await sleep(1800);
  const meter = await panel().evaluate(() => ({
    time: document.querySelector('.stt-time')?.textContent,
    loudest: Math.max(
      ...[...document.querySelectorAll('.stt-bars span')].map(bar =>
        Number(/scaleY\(([\d.]+)\)/.exec(bar.style.transform)?.[1] ?? 0),
      ),
    ),
  }));
  assert.match(meter.time, /^0:0[1-9]$/, 'the timer runs');
  assert.ok(meter.loudest > 0.3, `the level meter follows the voice (loudest bar ${meter.loudest})`);

  mock.dictation.delayMs = 1200;
  await press('Stop: the words go in the box to edit');
  await waitFor(async () => (await stripStatus()) === 'transcribing', 'transcribing');
  assert.ok((await session.panelText()).includes('Transcribing'));
  await waitFor(async () => (await stripStatus()) === null, 'the words to arrive');
  mock.dictation.delayMs = 0;

  const value = await panel().evaluate(() => document.querySelector('textarea').value);
  assert.equal(value, 'Note: remind me to call Ada at five');
  assert.equal(mock.dictation.recordings.length, 1);
  assert.equal(mock.dictation.recordings[0].mimeType, 'audio/webm');
  assert.ok(mock.dictation.recordings[0].bytes > 1000, 'the recording was sent to be written down');
});

test('Send while listening sends the words as soon as they are written down', async () => {
  await typeText('');
  mock.dictation.text = 'Run the scripted scenario dictated.';
  mock.start('dictated');
  await press('Start voice input');
  await waitFor(async () => (await stripStatus()) === 'listening', 'listening');
  await sleep(800);
  mock.dictation.delayMs = 1200;
  // The task runs on the page in front
  await session.web.bringToFront();
  await press('Send when transcribed');
  await waitFor(
    () => panel().evaluate(() => !!document.querySelector('button[aria-label="Sends when transcribed"]')),
    'the send button to wait for the words',
  );
  assert.ok((await session.panelText()).includes('Transcribing, then sending'));
  // The words were the message: the chat is named after them, and the task ran to its end
  const thread = await waitForThread(
    panel(),
    'Run the scripted scenario dictated.',
    candidate => candidate.status === 'idle' && mock.run.navigatorCalls.length > 0,
    30000,
  );
  assert.equal(thread.title, 'Run the scripted scenario dictated.');
  mock.dictation.delayMs = 0;
  assert.equal(mock.dictation.recordings.length, 2);
});

test('a transcription that fails sends nothing and keeps what was typed', async () => {
  await panel().bringToFront();
  await waitFor(() => panel().evaluate(() => !!document.querySelector('textarea:not([disabled])')), 'the composer');
  await typeText('Keep me');
  mock.dictation.failStatus = 400;
  await press('Start voice input');
  await waitFor(async () => (await stripStatus()) === 'listening', 'listening');
  await sleep(600);
  await press('Send when transcribed');
  await waitFor(() => panel().evaluate(() => !!document.querySelector('[role="alert"]')), 'the error');
  await waitFor(async () => (await stripStatus()) === null, 'the composer to come back');
  mock.dictation.failStatus = 0;
  const value = await panel().evaluate(() => document.querySelector('textarea').value);
  assert.equal(value, 'Keep me');
  assert.equal(mock.dictation.recordings.length, 3);
});

test('Esc drops a recording without sending it anywhere', async () => {
  await press('Start voice input');
  await waitFor(async () => (await stripStatus()) === 'listening', 'listening');
  await sleep(500);
  await panel().evaluate(() =>
    document.querySelector('form').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  await waitFor(async () => (await stripStatus()) === null, 'the strip to close');
  await sleep(1000);
  assert.equal(mock.dictation.recordings.length, 3, 'nothing was sent to be written down');
  assert.equal(await panel().evaluate(() => document.querySelector('textarea').value), 'Keep me');
  assert.deepEqual(session.panelErrors, []);
});

/** Every message, straight from the extension's IndexedDB. */
const readMessages = page =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('messages').objectStore('messages').getAll();
          all.onsuccess = () =>
            resolve(all.result.map(({ threadId, actor, content }) => ({ threadId, actor, content })));
          all.onerror = () => reject(all.error);
        };
      }),
  );

/** A command to the background over a panel connection of its own, as the panel sends it; waits for `reply`. */
const panelCommand = (message, reply) =>
  panel().evaluate(
    async (message, reply) => {
      const port = chrome.runtime.connect({ name: 'side-panel-connection' });
      const answered = new Promise(resolve => {
        port.onMessage.addListener(answer => answer.type === reply && resolve(answer));
        setTimeout(resolve, reply ? 30_000 : 500);
      });
      port.postMessage({ ...message, windowId: (await chrome.windows.getCurrent()).id });
      const answer = await answered;
      port.disconnect();
      return answer ?? null;
    },
    message,
    reply,
  );

test('dictating while a voice conversation runs in another chat: the conversation hears none of it, and the words are answered once', async () => {
  // A Gemini Live conversation (the mock's) started from the panel, while the panel shows a different chat
  await extension.setStorage({
    'voice-engine-settings': { mode: 'live', modeChosen: true },
    'meeting-settings': {
      liveModel: 'gemini-3.8-live',
      autoNotes: false,
      liveEndpoint: `ws://127.0.0.1:${mock.port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
    },
  });
  // A harmless tool for the mock to call once it has heard a second of the microphone
  mock.live.voiceTool = { name: 'get_status', args: {} };
  const started = await panelCommand({ type: 'voice_start' }, 'voice_started');
  assert.equal(started?.ok, true, JSON.stringify(started));
  await waitFor(() => mock.live.sessions.some(s => s.voice && s.setups.length), 'the voice conversation', 30000);
  const voice = mock.live.sessions.find(s => s.voice);
  // It hears the microphone (the recording plays on a loop)
  await waitFor(() => voice.audioBytes > 0, 'the conversation to hear the microphone', 20000);

  await panel().bringToFront();
  await typeText('');
  mock.dictation.text = 'Run the scripted scenario dictated.';
  mock.start('dictated');
  await press('Start voice input');
  await waitFor(async () => (await stripStatus()) === 'listening', 'listening');
  // The hold reaches the offscreen document a moment after the microphone opens
  await sleep(600);
  const heardBefore = voice.audioBytes;
  // Longer than the recording's longest pause (about 3.5 s), so speech plays while it waits
  await sleep(4500);
  assert.equal(voice.audioBytes, heardBefore, 'no microphone audio reached the conversation while dictating');

  await press('Stop: the words go in the box to edit');
  await waitFor(async () => (await stripStatus()) === null, 'the words to arrive');
  assert.equal(
    await panel().evaluate(() => document.querySelector('textarea').value),
    'Run the scripted scenario dictated.',
  );
  // Dictation over: the conversation hears the microphone again
  const after = voice.audioBytes;
  await waitFor(() => voice.audioBytes > after, 'the conversation to hear the microphone again', 20000);

  const userMessages = async () =>
    (await readMessages(panel())).filter(m => m.actor === 'user' && m.content === 'Run the scripted scenario dictated.')
      .length;
  const before = await userMessages();
  await session.send('Run the scripted scenario dictated.');
  await waitFor(() => mock.run.navigatorCalls.length > 0, 'the chat to run the words', 30000);
  await sleep(1500);
  // One answer: the chat on screen ran the words once, and nothing went to the conversation, typed or spoken
  assert.equal((await userMessages()) - before, 1);
  assert.equal(mock.live.typed.length, 0, 'the dictated words were not sent to the conversation');
  const voiceThread = (await readThreads(panel())).find(t => t.tags?.includes('voice'));
  const voiceUser = (await readMessages(panel())).filter(m => m.threadId === voiceThread?.id && m.actor === 'user');
  assert.ok(!voiceUser.some(m => /scenario dictated/.test(m.content)), 'the conversation never heard the words');
  await panelCommand({ type: 'voice_stop' });
});
