import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension, restartServiceWorker, sleep } from './harness.mjs';
import { startMockCompanion } from './mock-companion.mjs';
import { startMockLlm } from './mock-llm.mjs';

/**
 * The background stops in the middle of a WhatsApp voice note, and the answer still reaches him: the real extension,
 * its real service worker stopped while "recording…" waits on a mock Ava Brain. The chat had finished, so nothing
 * would ever start the answer again but the check at startup. Once, in words, quoting his message.
 */

const FINISHED = 'E2E scenario finished.';
const scenarios = { 'wa-restart': [() => [{ done: { text: FINISHED, success: true } }]] };

let mock;
let companion;
let extension;
let page;

async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await Promise.resolve()
      .then(check)
      .catch(() => null);
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

before(async () => {
  mock = await startMockLlm(scenarios);
  companion = await startMockCompanion();
  extension = await launchExtension(mock);
  page = await extension.browser.newPage();
  await page.goto(`${extension.origin}/sidepanel.html`);
  await page.waitForSelector('textarea', { timeout: 15000 });
  await command(page, { type: 'brain_pair', code: companion.code, port: companion.port });
  // Every answer tries to go as a voice note, so a typed message reaches the same path
  await command(page, { type: 'wava_settings', voiceForText: true });
});

after(async () => {
  await extension?.close();
  await companion?.close();
  await mock?.close();
});

test('an answer caught by a restart mid voice note still reaches him, once, in words', async () => {
  const { whatsapp } = companion;
  mock.start('wa-restart');
  whatsapp.holdRecording = true;
  whatsapp.inbox.push({ id: 'wa-r1', text: 'Are you there?', at: Date.now(), kind: 'text', media: null, link: null });
  await until(() => whatsapp.presences.includes('recording'), 'the voice note started');
  assert.deepEqual(whatsapp.sent, [], 'nothing went yet');

  whatsapp.holdRecording = false;
  await restartServiceWorker(extension, page);
  const answer = await until(
    () => whatsapp.sent.find(item => item.replyTo === 'wa-r1'),
    `the answer after the restart (sent: ${JSON.stringify(whatsapp.sent)})`,
  );
  assert.equal(answer.text, FINISHED);
  assert.equal(answer.quote, true, 'it comes late, so it quotes what it answers');

  // Starting again finds it marked as sent
  await restartServiceWorker(extension, page);
  await sleep(3000);
  assert.equal(whatsapp.sent.filter(item => item.replyTo === 'wa-r1').length, 1, 'sent once');
});
