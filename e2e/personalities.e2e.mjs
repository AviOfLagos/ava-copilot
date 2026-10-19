import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of personalities: the header's quick switch changes the instructions the next model request
 * carries, and a personality the user writes in Settings is used the same way.
 */

const done = () => [{ done: { text: 'Done.', success: true } }];
const scenarios = { 'persona-a': [done], 'persona-b': [done] };
// Screenshots for review go here when E2E_SHOTS is set
const SHOTS = process.env.E2E_SHOTS;

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

const shot = async (page, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

/** Radix opens its menu on keydown (a synthetic click does not); see shell.e2e.mjs. */
async function openPicker(panel) {
  await panel.bringToFront();
  await panel.evaluate(() => {
    const el = document.querySelector('[data-testid="personality-picker"]');
    if (!el) throw new Error('No personality picker');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await panel.waitForSelector('[role="menuitemradio"]', { timeout: 5000 });
}

const pick = (panel, name) =>
  panel.evaluate(name => {
    const item = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].find(el =>
      el.innerText.includes(name),
    );
    if (!item) throw new Error(`No menu item "${name}"`);
    item.click();
  }, name);

/** Sets a React-controlled input or textarea by its id. */
const fill = (panel, id, value) =>
  panel.evaluate(
    (id, value) => {
      const el = document.getElementById(id);
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    id,
    value,
  );

test('switching personality from the header puts its instructions in the next model request', async () => {
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 760 });

  await openPicker(session.panel);
  const items = await session.panel.$$eval('[role="menuitemradio"]', els => els.map(el => el.innerText));
  assert.equal(items.length, 6);
  assert.ok(items.some(text => text.includes('Bezos-style operator') && /inspired by/i.test(text)));
  await sleep(400);
  await shot(session.panel, 'personality-picker');

  await pick(session.panel, 'Accountant');
  await session.panel.waitForFunction(
    () =>
      document.querySelector('[data-testid="personality-picker"]')?.getAttribute('aria-label')?.includes('Accountant'),
    { polling: 300, timeout: 5000 },
  );
  assert.equal((await extension.getStorage('personalities')).activeId, 'accountant');
  // The name by the assistant's says so too
  assert.match(await session.panelText(), /Ava · 🧾 Accountant/i);

  mock.start('persona-a');
  await session.send('Run the scripted scenario persona-a');
  await session.waitForEnd();
  const requests = mock.runs.get('persona-a').requests;
  assert.ok(requests.length > 0);
  assert.ok(
    requests.every(text => text.includes('# PERSONALITY: Accountant')),
    'every agent call has it',
  );
  assert.match(requests[0], /Numbers first: lead with the figure/);
  // Below the rules: the gate's section comes first
  assert.ok(requests[0].indexOf('# PERSONALITY') > requests[0].indexOf('# COMMIT ACTIONS'), 'after the gate rules');
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test('a personality written in Settings is used for the next task', async () => {
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 760 });
  await openPicker(session.panel);
  await pick(session.panel, 'Manage personalities');
  // Manage opens the full-page Settings at Personalities
  const settings = await extension.settingsTab('#personalities');
  await settings.waitForSelector('[aria-label="All personalities"]', { timeout: 10000 });

  await extension.clickOn(settings, 'New personality');
  await settings.waitForSelector('#persona-name');
  await fill(settings, 'persona-icon', '🏴‍☠️');
  await fill(settings, 'persona-name', 'Pirate captain');
  await fill(settings, 'persona-description', 'Talks like a pirate.');
  await fill(settings, 'persona-instructions', 'Say "arr" at the start of every answer. Call the user captain.');
  await sleep(200);
  await extension.clickOn(settings, 'Save');
  await settings.waitForSelector('[aria-label="Use Pirate captain"]', { timeout: 5000 });
  const stored = await extension.getStorage('personalities');
  assert.equal(stored.custom.length, 1);
  assert.equal(stored.custom[0].name, 'Pirate captain');

  await extension.clickOn(settings, 'Use Pirate captain');
  await settings.waitForFunction(
    () => document.querySelector('[aria-label="Use Pirate captain"]')?.getAttribute('aria-pressed') === 'true',
    { polling: 300, timeout: 5000 },
  );
  await sleep(300);
  await shot(settings, 'personality-settings');
  await session.panel.bringToFront();

  mock.start('persona-b');
  await session.click('New thread');
  await session.panel.waitForSelector('textarea');
  await session.send('Run the scripted scenario persona-b');
  await session.waitForEnd();
  const requests = mock.runs.get('persona-b').requests;
  assert.match(requests[0], /# PERSONALITY: Pirate captain/);
  assert.match(requests[0], /Call the user captain/);
  assert.doesNotMatch(requests[0], /# PERSONALITY: Accountant/);
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});
