import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension } from './harness.mjs';
import { startMockLlm } from './mock-llm.mjs';

/** A chat keeps its own voice setup: the picker in its bar stores it, and a new chat starts on the defaults. */

const answer = text => () => [{ done: { text, success: true } }];

let mock;
let extension;
let page;

const threads = () =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('threads').objectStore('threads').getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        };
      }),
  );

before(async () => {
  mock = await startMockLlm({ 'thread-voice': [answer('Done.')] });
  extension = await launchExtension(mock);
  page = await extension.browser.newPage();
  await page.goto(`${extension.origin}/sidepanel.html`);
  await page.waitForSelector('textarea', { timeout: 15000 });
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

test('the picker in the chat bar stores the language on that chat', async () => {
  mock.start('thread-voice');
  await page.type('textarea', 'say hello');
  await page.keyboard.press('Enter');
  const button = await page.waitForSelector('button[data-testid="thread-voice"]', { timeout: 15000 });
  await button.click();
  const language = await page.waitForSelector('label:has(select) select:has(option[value="fr-FR"])');
  await language.select('fr-FR');
  await page.waitForFunction(
    () => document.querySelector('button[data-testid="thread-voice"]')?.className.includes('text-primary'),
    { timeout: 5000 },
  );
  const [thread] = await threads();
  assert.equal(thread.voice.language, 'fr-FR');
  assert.equal(thread.voice.hear ?? null, null);
});
