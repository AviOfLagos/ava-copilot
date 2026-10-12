// Screenshots of the new shell (WS1) at ~400px, for looking at the design: the drawer, the profile
// popover (opens upward) and a chat row's "⋯" menu (floats above the list, solid, fully on screen).
// Run: node e2e/manual/shell.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, openSession, sleep } from '../harness.mjs';

const out = process.argv[2] ?? 'screens';
fs.mkdirSync(out, { recursive: true });

// Radix's dropdown trigger opens on `pointerdown` or a keyboard Enter/Space, not `click`, so a
// synthetic element.click() from evaluate() never opens it. Puppeteer's native
// `ElementHandle.click()` is not a fix either: with this Brave build under CDP it hangs in
// `clickablePoint()`'s `Runtime.callFunctionOn` round trip until the default 180000ms
// `protocolTimeout`. This focuses the trigger and dispatches a real `keydown` for Enter instead.
async function openAccountMenu(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Account menu"]');
    if (!el) throw new Error('No button "Account menu"');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

async function openRowMenu(page, rowText) {
  await page.evaluate(rowText => {
    const row = [...document.querySelectorAll('li')].find(li => li.innerText.includes(rowText));
    const trigger = row?.querySelector('button[aria-label^="More for"]');
    if (!trigger) throw new Error(`No row menu trigger for "${rowText}"`);
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }, rowText);
}

const done = () => [{ done: { text: 'Done.', success: true } }];
const mock = await startMockLlm({ 'shell-shot': [done] });
const extension = await launchExtension(mock);
const session = await openSession(extension, mock);
await session.panel.setViewport({ width: 400, height: 760 });

// A thread to show in the history list and open its row menu
mock.start('shell-shot');
await session.send('Run the scripted scenario shell-shot.');
await session.waitForEnd();
await session.click('New thread');

await session.panel.bringToFront();

// 1. The drawer: top places, chats by date, the profile button at the foot
await session.click('Menu');
await sleep(400);
await session.panel.screenshot({ path: path.join(out, 'shell-drawer.png') });

// 2. The profile popover, opened upward
await openAccountMenu(session.panel);
await sleep(250);
await session.panel.screenshot({ path: path.join(out, 'shell-profile-menu.png') });
await session.panel.keyboard.press('Escape');
await sleep(200);

// 3. A chat row's "⋯" menu, floating above the list
await openRowMenu(session.panel, 'shell-shot');
await sleep(250);
await session.panel.screenshot({ path: path.join(out, 'shell-row-menu.png') });
await session.panel.keyboard.press('Escape');
await sleep(200);
await openAccountMenu(session.panel);
await sleep(200);
await session.click('Workspaces');
await sleep(250);
await session.panel.screenshot({ path: path.join(out, 'shell-workspaces.png') });

await extension.close();
await mock.close();
