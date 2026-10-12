import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of the shell (WS1): the drawer's top list and profile popover, the floating row
 * menu (profile and chat-row "⋯", both Radix dropdown menus) and the default workspace.
 */

const done = () => [{ done: { text: 'Done.', success: true } }];
const scenarios = { 'shell-a': [done] };

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

/** The bounding rect of the first element the panel finds matching `selector`. */
const rectOf = (page, selector) =>
  page.evaluate(selector => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const { top, bottom, left, right, width, height } = el.getBoundingClientRect();
    return { top, bottom, left, right, width, height };
  }, selector);

/**
 * Radix's dropdown trigger opens on `pointerdown` or a keyboard Enter/Space, not `click` (so the
 * same mouse gesture can drag to an item and release to pick it) — so a synthetic
 * `element.click()` from `page.evaluate`, what the harness's own `session.click(label)` uses,
 * never opens it. Puppeteer's own `ElementHandle.click()` is not a fix either: it resolves
 * `clickablePoint()` through a `Runtime.callFunctionOn` round trip that, with this Brave build
 * under CDP, never returns (confirmed: it fails at exactly the default 180000ms
 * `protocolTimeout`, every time). These instead focus the trigger and dispatch a real `keydown`
 * for Enter, synthetically, inside one plain `evaluate()` call — the same native-event-via-
 * `evaluate()` style every other test in this suite already uses for its clicks.
 */
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

test('the drawer shows the everyday places on top, and the profile menu opens upward with the account-ish ones', async () => {
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 760 });
  // A background tab gets no animation frames (CLAUDE.md), so the row menu's Radix exit animation
  // would never fire `animationend` and Presence would never unmount it. The panel must be the
  // foreground tab for Esc/outside-click to actually remove the menu, not just mark it closed.
  await session.panel.bringToFront();

  await session.click('Menu');
  await session.panel.waitForSelector('[role="dialog"]');
  // The everyday places: Home stays (its label is "Home" and "New chat" rather than duplicated),
  // Today and Meetings are the other core places on top
  await session.panel.waitForFunction(
    () => document.body.innerText.includes('Today') && document.body.innerText.includes('Meetings'),
    { polling: 300 },
  );
  // Knowledge base and Settings left the top list
  const topText = await session.panel.evaluate(() => document.querySelector('nav[aria-label]')?.innerText ?? '');
  assert.doesNotMatch(topText, /Knowledge base/);
  assert.doesNotMatch(topText, /Settings/);

  // The profile button opens a popover, upward, with the account-ish places
  await openAccountMenu(session.panel);
  await session.panel.waitForSelector('[role="menu"]', { timeout: 5000 });
  await sleep(150); // the open animation

  const menuText = await session.panel.evaluate(() => document.querySelector('[role="menu"]')?.innerText ?? '');
  for (const label of ['Knowledge base', 'Workspaces', 'Skills', 'Settings', 'How do I…']) {
    assert.match(menuText, new RegExp(label), `profile menu should list "${label}"`);
  }

  const menuRect = await rectOf(session.panel, '[role="menu"]');
  const triggerRect = await rectOf(session.panel, '[aria-label="Account menu"]');
  assert.ok(menuRect && triggerRect, 'both the menu and its trigger should be on screen');
  assert.ok(menuRect.bottom <= triggerRect.top + 2, 'the profile menu opens above its trigger');

  // Esc closes the popover first, leaving the drawer itself open. Radix defers the unmount until
  // its 150ms exit animation's `animationend` fires and the resulting state update commits, so
  // this polls rather than sleeping a fixed, easy-to-undershoot amount.
  await session.panel.keyboard.press('Escape');
  await session.panel.waitForFunction(() => !document.querySelector('[role="menu"]'), { timeout: 3000, polling: 50 });
  assert.ok(await session.panel.$('[role="dialog"]'), 'the drawer stays open after the first Escape');

  // A second Escape, with no menu left open, closes the drawer
  await session.panel.keyboard.press('Escape');
  await session.panel.waitForFunction(() => !document.querySelector('[role="dialog"]'), {
    timeout: 3000,
    polling: 50,
  });
  await session.close();
});

test('a chat row\'s "⋯" menu floats in a portal above the scrolling list, fully inside the viewport, and Esc closes it', async () => {
  mock.start('shell-a');
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 760 });
  await session.send('Run the scripted scenario shell-a.');
  await session.waitForEnd();
  // `send()` focused the web page for the agent; bring the panel back so its row menu's exit
  // animation actually gets frames (a background tab gets none — see the note in the first test).
  await session.panel.bringToFront();

  await session.click('New thread');
  await session.click('Menu');
  await session.panel.waitForFunction(() => document.body.innerText.includes('shell-a'), { polling: 300 });

  await openRowMenu(session.panel, 'shell-a');
  await session.panel.waitForSelector('[role="menu"][data-row-menu="history"]', { timeout: 5000 });
  await sleep(150);

  // It is portaled to the document body, not nested inside the scrolling history region
  const inPortal = await session.panel.evaluate(() => {
    const menu = document.querySelector('[role="menu"][data-row-menu="history"]');
    const historyRegion = document.querySelector('[role="region"]');
    return Boolean(menu) && Boolean(historyRegion) && !historyRegion.contains(menu) && document.body.contains(menu);
  });
  assert.ok(inPortal, 'the row menu renders outside the scrolling history region, at the document body level');

  // It fits entirely inside the 400x760 panel viewport Radix was told to avoid colliding with
  const rect = await rectOf(session.panel, '[role="menu"][data-row-menu="history"]');
  assert.ok(rect, 'the row menu should be on screen');
  assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= 400 && rect.bottom <= 760, 'the row menu stays on screen');

  await session.panel.keyboard.press('Escape');
  await session.panel.waitForFunction(() => !document.querySelector('[role="menu"]'), { timeout: 3000, polling: 50 });
  await session.close();
});

test('the default workspace persists across a reopen, and the Workspaces place shows which one it is', async () => {
  const session = await openSession(extension, mock);
  // A background tab gets no animation frames, so the profile menu's Radix exit animation would
  // never fire `animationend` and would stay mounted, invisible-but-present, over the next place.
  await session.panel.bringToFront();
  // Visiting Home (openSession already waits for its composer) seeds the workspaces store,
  // including the default, on a fresh profile; give the async storage write a moment to land.
  await sleep(300);

  let stored = await extension.getStorage('workspaces');
  assert.equal(stored.defaultWorkspaceId, 'nexprove', 'a fresh install starts with Nexprove as the default');

  await session.click('Menu');
  await openAccountMenu(session.panel);
  await session.click('Workspaces');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Ellum AI'), { polling: 300 });

  // Nexprove's star shows it is the default; Ellum AI's does not. Found by the star button's own
  // aria-label (it names the workspace either way), not by an ancestor's text — querySelectorAll
  // returns outer wrappers before their children, so matching on a row's combined text would grab
  // the whole list's container instead of one row.
  const pressed = await session.panel.evaluate(() => {
    const starFor = name =>
      [...document.querySelectorAll('button[aria-pressed]')].find(b => b.getAttribute('aria-label')?.includes(name));
    return {
      nexprove: starFor('Nexprove')?.getAttribute('aria-pressed'),
      ellum: starFor('Ellum AI')?.getAttribute('aria-pressed'),
    };
  });
  assert.equal(pressed.nexprove, 'true');
  assert.equal(pressed.ellum, 'false');

  // Changing it persists, and survives leaving and returning to the place
  await session.panel.evaluate(() => {
    const star = [...document.querySelectorAll('button[aria-pressed]')].find(b =>
      b.getAttribute('aria-label')?.includes('Ellum AI'),
    );
    star.click();
  });
  await sleep(300);
  stored = await extension.getStorage('workspaces');
  assert.equal(stored.defaultWorkspaceId, 'ellum-ai');

  await session.click('New thread');
  await session.click('Menu');
  await openAccountMenu(session.panel);
  await session.click('Workspaces');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Ellum AI'), { polling: 300 });
  const stillPressed = await session.panel.evaluate(() => {
    const star = [...document.querySelectorAll('button[aria-pressed]')].find(b =>
      b.getAttribute('aria-label')?.includes('Ellum AI'),
    );
    return star?.getAttribute('aria-pressed');
  });
  assert.equal(stillPressed, 'true', 'the default survives leaving and returning to the Workspaces place');
  await session.close();
});
