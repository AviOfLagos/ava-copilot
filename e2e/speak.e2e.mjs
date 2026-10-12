import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep, waitForThread } from './harness.mjs';

/**
 * End-to-end tests of WS2: the Speak button (system voices via chrome.tts) and Retry (re-running the
 * last task, and forking from a user message to retry it).
 */

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const scenarios = {
  'speak-once': [done],
  'retry-once': [done],
  'retry-from-once': [done],
};

let mock;
let extension;

/** The background service worker, the same way harness.mjs itself finds it to read its manifest. */
async function backgroundWorker(extension) {
  for (const target of extension.browser.targets()) {
    if (target.type() === 'service_worker' && target.url().startsWith(extension.origin)) {
      return target.worker();
    }
  }
  throw new Error('No background service worker found');
}

/**
 * Replaces chrome.tts in the background with a stand-in: no system voice is required, calls are
 * recorded, and `onEvent` is kept so a test can end an utterance (or stop it) on its own terms.
 */
async function stubChromeTts(extension) {
  const worker = await backgroundWorker(extension);
  await worker.evaluate(() => {
    self.__tts = { calls: [], stops: 0 };
    chrome.tts.speak = (text, options) => {
      self.__tts.calls.push({ text, enqueue: options?.enqueue ?? false, rate: options?.rate });
      self.__tts.lastOnEvent = options?.onEvent ?? null;
    };
    chrome.tts.stop = () => {
      self.__tts.stops += 1;
      self.__tts.lastOnEvent?.({ type: 'interrupted' });
      self.__tts.lastOnEvent = null;
    };
  });
  return {
    reset: () => worker.evaluate(() => void (self.__tts = { calls: [], stops: 0 })),
    calls: () => worker.evaluate(() => self.__tts.calls),
    stops: () => worker.evaluate(() => self.__tts.stops),
    // The utterance finishes on its own, as chrome.tts would report once the voice is done
    finish: () => worker.evaluate(() => self.__tts.lastOnEvent?.({ type: 'end' })),
  };
}

/** Reads the session-storage flag the background sets while something is speaking. */
function speakingFlag(page) {
  return page.evaluate(() => chrome.storage.session.get('tts-speaking').then(stored => stored['tts-speaking']));
}

// The Speak/Stop button carries no visible text, only an aria-label - innerText never has it
function waitForButton(page, label, present = true) {
  return page.waitForFunction(
    (label, present) => !!document.querySelector(`button[aria-label="${label}"]`) === present,
    { polling: 300 },
    label,
    present,
  );
}

/**
 * Clicks a button by its visible text or accessible name, retrying for a moment: the panel's live
 * queries can re-render it out and back in right as a run settles, and harness.mjs's own `click()`
 * looks only once.
 */
async function clickRobust(page, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const clicked = await page.evaluate(label => {
      const button = [...document.querySelectorAll('button')].find(b => {
        const text = b.innerText.trim();
        return text === label || text.startsWith(`${label}\n`) || b.getAttribute('aria-label') === label;
      });
      if (!button) return false;
      button.click();
      return true;
    }, label);
    if (clicked) return;
    if (Date.now() > deadline) throw new Error(`No button "${label}" (after retrying for ${timeout}ms)`);
    await sleep(150);
  }
}

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const task = name => `Run the scripted scenario ${name}.`;

test('the Speak button calls chrome.tts with the answer, and Stop interrupts it', async () => {
  const tts = await stubChromeTts(extension);
  await tts.reset();
  mock.start('speak-once');
  const session = await openSession(extension, mock);
  await session.send(task('speak-once'));
  await session.waitForEnd();

  await clickRobust(session.panel, 'Read aloud');
  await waitForButton(session.panel, 'Stop reading', true);
  const calls = await tts.calls();
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /E2E scenario finished/);

  const flag = await speakingFlag(session.panel);
  assert.ok(flag.threadId, 'the background marks a thread as speaking');
  assert.ok(flag.messageId, 'the background marks a message as speaking');

  // speak() itself calls chrome.tts.stop() defensively before speaking (one speaker at a time), so
  // the Stop button's own call is one more than whatever that already was, not the first ever
  const stopsBeforeClick = await tts.stops();
  await clickRobust(session.panel, 'Stop reading');
  await waitForButton(session.panel, 'Stop reading', false);
  assert.equal(await tts.stops(), stopsBeforeClick + 1);
  assert.deepEqual(await speakingFlag(session.panel), { threadId: null, messageId: null });
  await session.close();
});

test('a clip that finishes on its own clears the speaking flag and the button reverts', async () => {
  const tts = await stubChromeTts(extension);
  await tts.reset();
  mock.start('speak-once');
  const session = await openSession(extension, mock);
  await session.send(task('speak-once'));
  await session.waitForEnd();

  await clickRobust(session.panel, 'Read aloud');
  await waitForButton(session.panel, 'Stop reading', true);
  await tts.finish();
  await waitForButton(session.panel, 'Stop reading', false);
  assert.deepEqual(await speakingFlag(session.panel), { threadId: null, messageId: null });
  await session.close();
});

test('Retry re-runs the last task with a fresh agent', async () => {
  mock.start('retry-once');
  const session = await openSession(extension, mock);
  await session.send(task('retry-once'));
  await session.waitForEnd();
  await waitForThread(session.panel, 'retry-once', t => t.status === 'idle');

  await clickRobust(session.panel, 'Retry');
  await session.panel
    .waitForFunction(() => (document.body.innerText.match(/E2E scenario finished/g) ?? []).length >= 2, {
      timeout: 15000,
      polling: 300,
    })
    .catch(async error => {
      throw new Error(`${error.message}. Panel: ${(await session.panelText()).slice(-600)}`);
    });
  await waitForThread(session.panel, 'retry-once', t => t.status === 'idle');
  assert.match(await session.panelText(), /Trying the task again from the start/);
  await session.close();
});

test('Retry from here forks the thread just before that message and sends it again', async () => {
  mock.start('retry-from-once');
  const session = await openSession(extension, mock);
  await session.send(task('retry-from-once'));
  const original = await waitForThread(session.panel, 'retry-from-once', t => t.status === 'idle' && !t.forkedFrom);

  await clickRobust(session.panel, 'Retry from here');
  const fork = await waitForThread(session.panel, 'retry-from-once. (branch)');
  // Forked just before the message (seq 0, not 1), so sending it again does not duplicate it
  assert.deepEqual(fork.forkedFrom, { threadId: original.id, seq: 0 });
  // The original never matched a workspace, so its field is simply absent (undefined); the fork
  // normalizes "no workspace" to null explicitly. Both mean the same thing: no workspace
  assert.equal(fork.workspaceId ?? null, original.workspaceId ?? null);
  assert.equal(fork.origin, original.origin);
  assert.equal(original.origin, 'user');
  await waitForThread(session.panel, 'retry-from-once. (branch)', t => t.status === 'idle');
  // The panel followed the new thread
  await session.panel.waitForFunction(() => document.body.innerText.includes('retry-from-once'), { polling: 300 });
  await session.close();
});
