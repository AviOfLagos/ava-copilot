import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep, waitForThread } from './harness.mjs';

/**
 * The vocabulary, as the user meets it: Settings › Voice › Vocabulary to add "Ellum" (heard as "Illum"); dictating
 * "Illum AI" then reads "Ellum AI" with the changed word underlined and a click putting "Illum" back; a real word
 * ("ilium") is left alone and offered as "Did you mean Ellum?"; a correction made by hand in the box is offered as a rule
 * and one tap keeps it. E2E_SHOTS=<dir> keeps screenshots. Everything is made up; no live model.
 */

process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');

const SHOTS = process.env.E2E_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'vocabulary-'));
fs.mkdirSync(SHOTS, { recursive: true });

let mock;
let extension;
let session;
const panel = () => session.panel;

before(async () => {
  mock = await startMockLlm({ typed: [() => [{ done: { text: 'Scripted steps complete.', success: true } }]] });
  extension = await launchExtension(mock);
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
  await panel().setViewport({ width: 380, height: 800 });
  await panel().bringToFront();
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const entries = () =>
  panel().evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('vocabulary').objectStore('vocabulary').getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        };
      }),
  );

const boxText = () => panel().evaluate(() => document.querySelector('textarea')?.value ?? '');
const setBox = value =>
  panel().evaluate(text => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);

async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Dictates `words` through the fake microphone and waits for them to land in the box. */
async function dictate(words) {
  mock.dictation.text = words;
  await panel().bringToFront();
  await setBox('');
  await panel().evaluate(() => document.querySelector('button[aria-label="Start voice input"]').click());
  await panel()
    .waitForSelector('.stt-strip[data-status="listening"]', { timeout: 8000 })
    .catch(async error => {
      const alert = await panel().evaluate(() => document.querySelector('[role="alert"]')?.innerText ?? '');
      throw new Error(`${error.message}. Alert: ${alert}. Recordings so far: ${mock.dictation.recordings.length}`);
    });
  await sleep(700);
  await panel().evaluate(() =>
    document.querySelector('button[aria-label="Stop: the words go in the box to edit"]').click(),
  );
  await waitFor(async () => (await boxText()).length > 0, 'the words');
}

test('Settings › Voice › Vocabulary: add "Ellum", heard as "Illum", and it shows with its count', async () => {
  const page = await extension.openSettings('#voice');
  try {
    await page.waitForSelector('#vocab-new-write', { timeout: 15000 });
    await page.type('#vocab-new-write', 'Ellum');
    await page.type('#vocab-new-heard', 'Illum, Elem');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Add').click());
    await waitFor(async () => (await entries()).some(e => e.write === 'Ellum'), 'the entry');
    const [entry] = (await entries()).filter(e => e.write === 'Ellum');
    assert.deepEqual(entry.heardAs, ['Illum', 'Elem']);
    assert.equal(entry.learnedFrom, 'avi');
    assert.equal(entry.workspaceId, null);
    await page.waitForFunction(
      () => document.querySelector('ul[aria-label="Vocabulary"]')?.innerText.includes('Used 0 times'),
      {
        timeout: 10000,
      },
    );
    await page.screenshot({ path: path.join(SHOTS, '1-settings.png') });
  } finally {
    await page.close();
  }
});

test('dictating "Illum AI" reads "Ellum AI": underlined, with the recogniser told the word', async () => {
  await dictate('Illum AI is ready for the demo');
  assert.equal(await boxText(), 'Ellum AI is ready for the demo');
  // Gemini was given the user's own words
  assert.match(mock.dictation.prompts.at(-1), /write them exactly this way: .*Ellum/);
  const mark = await panel().evaluate(() => document.querySelector('.vocab-mirror mark')?.textContent);
  assert.equal(mark, 'Ellum');
  await panel().screenshot({ path: path.join(SHOTS, '2-dictated.png') });
  // The count went up
  await waitFor(async () => (await entries()).find(e => e.write === 'Ellum')?.uses >= 1, 'the count');
});

test('clicking the corrected word offers to put "Illum" back, or never to change it', async () => {
  await panel().evaluate(() => {
    const area = document.querySelector('textarea');
    area.focus();
    area.setSelectionRange(2, 2);
    area.click();
  });
  await panel().waitForSelector('[data-testid="vocab-chip"]', { timeout: 5000 });
  assert.match(
    await panel().evaluate(() => document.querySelector('[data-testid="vocab-chip"]').innerText),
    /Changed .Illum. to .Ellum./,
  );
  await panel().screenshot({ path: path.join(SHOTS, '3-undo-chip.png') });
  await panel().evaluate(() =>
    [...document.querySelectorAll('[data-testid="vocab-chip"] button')]
      .find(b => b.innerText.includes('Put back'))
      .click(),
  );
  await waitFor(async () => (await boxText()) === 'Illum AI is ready for the demo', 'the old word back');
  // Putting it back by hand is not offered as a rule
  await sleep(1000);
  assert.equal(await panel().evaluate(() => document.querySelector('[data-testid="vocab-chip"]')?.innerText ?? ''), '');
});

test('a real word is left alone and offered: "ilium" is not turned into "Ellum" without a tap', async () => {
  await dictate('The ilium is part of the pelvis');
  assert.equal(await boxText(), 'The ilium is part of the pelvis');
  await panel().waitForSelector('[data-testid="vocab-chip"]', { timeout: 5000 });
  assert.match(
    await panel().evaluate(() => document.querySelector('[data-testid="vocab-chip"]').innerText),
    /Did you mean .Ellum.\?/,
  );
  await panel().screenshot({ path: path.join(SHOTS, '4-unsure-chip.png') });
  await panel().evaluate(() =>
    [...document.querySelectorAll('[data-testid="vocab-chip"] button')]
      .find(b => b.innerText.includes('Use it'))
      .click(),
  );
  await waitFor(async () => (await boxText()) === 'The Ellum is part of the pelvis', 'the word the user accepted');
});

test('a correction made by hand is offered as a rule, and one tap keeps it', async () => {
  await dictate('Please call Killon back');
  assert.equal(await boxText(), 'Please call Killon back');
  await setBox('Please call Quillon back');
  await panel().waitForSelector('[data-testid="vocab-chip"]', { timeout: 5000 });
  assert.match(
    await panel().evaluate(() => document.querySelector('[data-testid="vocab-chip"]').innerText),
    /Always write .Quillon. for .Killon.\?/,
  );
  await panel().screenshot({ path: path.join(SHOTS, '5-rule-chip.png') });
  await panel().evaluate(() =>
    [...document.querySelectorAll('[data-testid="vocab-chip"] button')]
      .find(b => b.innerText.trim() === 'Always')
      .click(),
  );
  await waitFor(async () => (await entries()).some(e => e.write === 'Quillon'), 'the rule');
  const rule = (await entries()).find(e => e.write === 'Quillon');
  assert.deepEqual(rule.heardAs, ['Killon']);
  assert.equal(rule.learnedFrom, 'avi');
});

test('the same correction made twice without a tap is saved anyway, and says so', async () => {
  for (const round of [1, 2]) {
    await dictate('Send it to Zor Vane today');
    assert.equal(await boxText(), 'Send it to Zor Vane today');
    await setBox('Send it to Zorvane today');
    await sleep(900);
    // Sent without answering the chip
    mock.start('typed');
    await session.web.bringToFront();
    await panel().evaluate(() => document.querySelector('button[type="submit"]').click());
    await waitForThread(panel(), 'Send it to Zorvane today', thread => thread.status === 'idle', 30000);
    if (round === 1) {
      // The recorder only starts again in a panel that has not sent yet in this harness: start the panel afresh
      await panel().reload();
      await panel().waitForSelector('textarea');
      await panel().bringToFront();
      await sleep(300);
      assert.equal(
        (await entries()).some(e => e.write === 'Zorvane'),
        false,
        'once is only noted',
      );
    }
  }
  await waitFor(async () => (await entries()).some(e => e.write === 'Zorvane'), 'the rule saved by itself');
  assert.equal((await entries()).find(e => e.write === 'Zorvane').learnedFrom, 'correction');
  await panel().waitForSelector('[data-testid="vocab-chip"]', { timeout: 5000 });
  assert.match(await panel().evaluate(() => document.querySelector('[data-testid="vocab-chip"]').innerText), /Saved/);
});
