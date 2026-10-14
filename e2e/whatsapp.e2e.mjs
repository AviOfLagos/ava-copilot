import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * Ava in WhatsApp Web, against a local WhatsApp-Web-like page served by request interception (never the real
 * web.whatsapp.com): catch-up from the chat, a drafted reply that waits for the click, and a bulk batch that
 * sends only after its approval, with pause/resume and stop. Screenshots of the new views go to
 * E2E_SCREENSHOTS when it is set.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures/whatsapp/web.html'), 'utf8');
const SHOTS = process.env.E2E_SCREENSHOTS;

const done = text => () => [{ done: { text, success: true } }];
const scenarios = {
  'wa-catchup': [
    () => [{ whatsapp_unread: { intent: 'Read the unread WhatsApp chats' } }],
    done('Priya asks if 3pm is still on; Tomi wants a call.'),
  ],
  'wa-draft': [
    () => [{ whatsapp_draft_reply: { intent: 'Reply to Tomi', chat: 'Tomi', message: "I'll call at 5" } }],
    done('Replied to Tomi.'),
  ],
};

let mock;
let extension;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

/** Serves the fixture for every web.whatsapp.com address the page (or the extension) opens in it. */
async function intercept(page) {
  await page.setRequestInterception(true);
  page.on('request', request =>
    request.url().startsWith('https://web.whatsapp.com/')
      ? request.respond({ status: 200, contentType: 'text/html', body: FIXTURE })
      : request.continue(),
  );
}

/** What the fixture recorded as sent. The tab may be mid-navigation, so it retries. */
async function sentIn(page) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-wa') || '{"sent":[]}').sent);
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Could not read the fixture state');
}

async function waitForSent(page, count, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let sent = [];
  while (Date.now() < deadline) {
    sent = await sentIn(page);
    if (sent.length >= count) return sent;
    await sleep(300);
  }
  throw new Error(`Expected ${count} sent, saw ${sent.length}: ${JSON.stringify(sent)}`);
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.bringToFront();
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** Sets a React-controlled textarea or input the way typing would. */
function fill(panel, selector, value) {
  return panel.evaluate(
    (selector, value) => {
      const field = document.querySelector(selector);
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    value,
  );
}

/** Clicks the first button whose text starts with `prefix`. */
function clickText(panel, prefix) {
  return panel.evaluate(prefix => {
    const button = [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(prefix));
    if (!button) throw new Error(`No button starting "${prefix}"`);
    button.click();
  }, prefix);
}

const waitForText = (panel, text, timeout = 20000) =>
  panel.waitForFunction(text => document.body.innerText.includes(text), { polling: 300, timeout }, text);

async function openBulk(session) {
  await session.click('Menu');
  await session.click('Inbox');
  await waitForText(session.panel, 'Sneak peek');
  await clickText(session.panel, 'WhatsApp');
  await waitForText(session.panel, 'Bulk message');
  await session.click('Bulk message');
  await waitForText(session.panel, 'Recipients (CSV)');
}

test('catch-up: Ava reads the unread chats from the WhatsApp tab, as data', async () => {
  mock.start('wa-catchup');
  const session = await openSession(extension, mock);
  await intercept(session.web);
  await session.web.goto('https://web.whatsapp.com/');
  await session.web.evaluate(() => localStorage.removeItem('fixture-wa'));
  await session.web.reload();
  await session.send('Run the scripted scenario wa-catchup. What did I miss on WhatsApp?');
  const text = await session.waitForEnd();
  assert.match(text, /E2E scenario finished/);
  const afterRead = mock.run.navigatorCalls[1] ?? '';
  assert.match(afterRead, /Priya Patel \(2\): See you at 3pm\?/);
  assert.match(afterRead, /Tomi \(1\): Can you call me later\?/);
  assert.doesNotMatch(afterRead, /Mom \(/, 'a read chat is not listed');
  assert.match(afterRead, /nano_untrusted_content/, 'chat text reaches the model wrapped as untrusted');
  assert.deepEqual(mock.run.errors, []);
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test('a drafted reply is typed into the chat and waits for the click before it sends', async () => {
  mock.start('wa-draft');
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 900 });
  await intercept(session.web);
  await session.web.goto('https://web.whatsapp.com/');
  await session.web.evaluate(() => localStorage.removeItem('fixture-wa'));
  await session.web.reload();
  await session.send('Run the scripted scenario wa-draft. Reply to Tomi saying I will call at 5.');

  const card = await session.waitForCard();
  assert.match(card, /I'll call at 5/, 'the card shows the exact message in the box');
  await shot(session.panel, 'wa-draft-card');
  const composer = await session.web.evaluate(
    () => document.querySelector('footer [contenteditable="true"]')?.textContent ?? '',
  );
  assert.equal(composer, "I'll call at 5", 'the draft is in the chat box');
  await sleep(1000);
  assert.deepEqual(await sentIn(session.web), [], 'nothing is sent before the click');

  await session.answer('Confirm');
  const sent = await waitForSent(session.web, 1);
  assert.deepEqual(sent, [{ to: 'Tomi', text: "I'll call at 5", attachment: null }]);
  await session.waitForEnd();
  assert.deepEqual(mock.run.errors, []);
  await session.close();
});

test('bulk: a batch shows every recipient, sends only after the approval, and reports', async () => {
  const whatsapp = await extension.browser.newPage();
  await intercept(whatsapp);
  await whatsapp.goto('https://web.whatsapp.com/');
  await whatsapp.evaluate(() => localStorage.removeItem('fixture-wa'));
  await whatsapp.reload();
  await extension.setStorage({
    'whatsapp-bulk-settings': {
      delayMinSec: 1,
      delayMaxSec: 1,
      cooldownEvery: 100,
      cooldownMinSec: 1,
      cooldownMaxSec: 1,
      dailyCap: 50,
    },
  });

  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 900 });
  await openBulk(session);
  await shot(session.panel, 'wa-bulk-compose-empty');
  await fill(
    session.panel,
    '#wa-bulk-csv',
    [
      'phone,name,city,opt_out',
      '+234 801 234 5678,Tomi,Lagos,',
      '4915112345678,Lena,"Berlin, DE",',
      '447700900123,Sam,London,',
      '2348012345678,Tomi again,Lagos,',
      '15550001111,Opted,Nowhere,yes',
    ].join('\n'),
  );
  await fill(session.panel, '#wa-bulk-template', 'Hi {{name}}, see you in {{city}}!');
  await waitForText(session.panel, '3 to send, 2 skipped.');
  await shot(session.panel, 'wa-bulk-compose');
  await clickText(session.panel, 'Review 3 messages');

  await waitForText(session.panel, 'Approve 3 messages?');
  const review = await session.panelText();
  assert.match(review, /Hi Tomi, see you in Lagos!/);
  assert.match(review, /Hi Lena, see you in Berlin, DE!/);
  assert.match(review, /Hi Sam, see you in London!/);
  assert.match(review, /Same number earlier in the list/);
  assert.match(review, /Asked not to be messaged/);
  assert.match(review, /banned by WhatsApp/, 'the ban warning is shown before approving');
  await shot(session.panel, 'wa-bulk-review');
  await sleep(1500);
  assert.deepEqual(await sentIn(whatsapp), [], 'nothing goes out before the batch approval');

  // The approval button needs a second click (or a hold)
  await clickText(session.panel, 'Approve and send 3');
  await sleep(200);
  assert.deepEqual(await sentIn(whatsapp), [], 'one click only arms it');
  await clickText(session.panel, 'Click again to send');

  const sent = await waitForSent(whatsapp, 3);
  assert.deepEqual(
    sent.map(entry => [entry.to, entry.text]),
    [
      ['+2348012345678', 'Hi Tomi, see you in Lagos!'],
      ['+4915112345678', 'Hi Lena, see you in Berlin, DE!'],
      ['+447700900123', 'Hi Sam, see you in London!'],
    ],
  );
  await waitForText(session.panel, 'Finished.');
  const report = await session.panelText();
  assert.match(report, /Sent 3/);
  assert.match(report, /Skipped 2/);
  await shot(session.panel, 'wa-bulk-report');

  const inbox = await session.panel.evaluate(
    () =>
      new Promise(resolve => {
        const open = indexedDB.open('avi-copilot');
        open.onsuccess = () => {
          const all = open.result.transaction('inbox').objectStore('inbox').getAll();
          all.onsuccess = () => resolve(all.result);
        };
      }),
  );
  assert.ok(
    inbox.some(item => item.source === 'whatsapp-bulk' && item.kind === 'result'),
    'a result lands in the Inbox',
  );
  assert.deepEqual(session.panelErrors, []);
  await session.close();
  await whatsapp.close();
});

test('bulk: pause holds the batch, resume finishes it, stop skips the rest; an unknown number is skipped', async () => {
  const whatsapp = await extension.browser.newPage();
  await intercept(whatsapp);
  await whatsapp.goto('https://web.whatsapp.com/');
  await whatsapp.evaluate(() => localStorage.removeItem('fixture-wa'));
  await whatsapp.reload();
  await extension.setStorage({
    'whatsapp-bulk-settings': {
      delayMinSec: 4,
      delayMaxSec: 4,
      cooldownEvery: 100,
      cooldownMinSec: 1,
      cooldownMaxSec: 1,
      dailyCap: 50,
    },
  });
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 900 });
  await openBulk(session);
  // The first batch's report is still shown: start a new one
  if ((await session.panelText()).includes('New batch')) await clickText(session.panel, 'New batch');

  const batch = async rows => {
    await waitForText(session.panel, 'Recipients (CSV)');
    await fill(session.panel, '#wa-bulk-csv', ['phone,name', ...rows].join('\n'));
    await fill(session.panel, '#wa-bulk-template', 'Hello {{name}}');
    await clickText(session.panel, 'Review ');
    await waitForText(session.panel, 'Approve and send');
    await clickText(session.panel, 'Approve and send');
    await sleep(100);
    await clickText(session.panel, 'Click again to send');
  };

  await batch(['4915100000001,Ada', '99900000000,Nobody', '4915100000003,Cy']);
  await waitForSent(whatsapp, 1);
  await session.click('Pause');
  await waitForText(session.panel, 'Paused.');
  await shot(session.panel, 'wa-bulk-paused');
  await sleep(6000);
  assert.equal((await sentIn(whatsapp)).length, 1, 'nothing goes out while paused');
  await session.click('Resume');
  const sent = await waitForSent(whatsapp, 2, 40000);
  assert.deepEqual(
    sent.map(entry => entry.to),
    ['+4915100000001', '+4915100000003'],
  );
  await waitForText(session.panel, 'Finished.', 30000);
  assert.match(await session.panelText(), /WhatsApp says this number is not on WhatsApp/);

  // Stop: after the first message, the rest is skipped and never sent
  await clickText(session.panel, 'New batch');
  await batch(['4915100000011,Bo', '4915100000012,Di', '4915100000013,Ed']);
  await waitForSent(whatsapp, 3);
  await session.click('Stop');
  await waitForText(session.panel, 'Stopped.');
  await sleep(6000);
  assert.equal((await sentIn(whatsapp)).length, 3, 'nothing goes out after stop');
  const text = await session.panelText();
  assert.match(text, /The batch was stopped/);
  assert.match(text, /Sent 1/);
  await shot(session.panel, 'wa-bulk-stopped');
  assert.deepEqual(session.panelErrors, []);
  await session.close();
  await whatsapp.close();
});

test('the WhatsApp view in the Inbox shows the catch-up tab with its Sneak peek mark', async () => {
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 900 });
  await session.click('Menu');
  await session.click('Inbox');
  await waitForText(session.panel, 'Sneak peek');
  await shot(session.panel, 'wa-inbox-entry');
  await clickText(session.panel, 'WhatsApp');
  await waitForText(session.panel, 'What did I miss?');
  await shot(session.panel, 'wa-catchup');
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});
