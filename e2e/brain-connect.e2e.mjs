// Obsidian and the calendar through Nex Brain: with a mock companion paired, Settings › Connections › Obsidian lists
// the vault it found and one click uses it (the copilot's memory is written into the vault and the user's note comes
// into the knowledge base, with no folder picker); Settings › Calendar shows macOS's permission state, "Allow access"
// asks for it, the calendars list, and the next meeting is read from the Mac. Nothing real is touched: the vault and
// the calendar are the mock's, in memory.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension, sleep } from './harness.mjs';
import { MOCK_VAULT, startMockCompanion } from './mock-companion.mjs';
import { startMockLlm } from './mock-llm.mjs';

let mock;
let companion;
let extension;

before(async () => {
  mock = await startMockLlm({});
  companion = await startMockCompanion({ calendarAccess: 'not_determined' });
  extension = await launchExtension(mock);
});

after(async () => {
  await extension?.close();
  await companion?.close();
  await mock?.close();
});

async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`${message} (timed out)`);
}

/** Sends a registered command over a port of its own, as the panel's PanelApi does. */
function command(page, message) {
  return page.evaluate(
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

function readStore(page, store) {
  return page.evaluate(
    store =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        };
      }),
    store,
  );
}

const text = page => page.evaluate(() => document.body.innerText);

test('pairs with Nex Brain', async () => {
  const panel = await extension.browser.newPage();
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.waitForSelector('textarea', { timeout: 15000 });
  await command(panel, { type: 'brain_pair', code: companion.code, port: companion.port });
  await panel.close();
});

test('Obsidian: picks the vault Nex Brain found, writes the memory into it and reads the user’s note', async () => {
  const settings = await extension.openSettings('#connections/obsidian');
  try {
    await settings.waitForSelector('[data-vault="brain-pick"] [data-vault-choice]', { timeout: 15000 });
    assert.match(await text(settings), /Your vaults/);
    assert.match(await text(settings), new RegExp(MOCK_VAULT.path));
    // No folder picker and no Brave flag steps while Nex Brain is paired
    assert.equal(await settings.$('[data-vault-brave]'), null);
    await extension.clickOn(settings, `Use ${MOCK_VAULT.name}`);
    await settings.waitForSelector('[data-vault="brain"]', { timeout: 15000 });
    assert.equal(companion.chosenVault(), MOCK_VAULT.id);

    const item = await until(
      async () =>
        (await readStore(settings, 'kbItems')).find(entry => entry.sourceId === 'vault:Projects/Blue folder.md'),
      'the user’s note came into the knowledge base',
    );
    assert.equal(item.title, 'Blue folder');
    // The setting is a plain one, so a backup carries it
    const kept = await extension.getStorage('obsidian-vault');
    assert.equal(kept.source, 'brain');
    assert.equal(kept.path, MOCK_VAULT.path);

    await extension.clickOn(settings, 'Sync now');
    // Done when the button is back (the last sync's line shows meanwhile)
    await settings.waitForFunction(
      () =>
        /Wrote \d+ notes, read \d+ of yours/.test(document.body.innerText) &&
        ![...document.querySelectorAll('button')].some(button => button.disabled && button.innerText === 'Syncing…'),
      {
        polling: 300,
        timeout: 20000,
      },
    );
    // The copilot never wrote over the user's note
    assert.match(companion.vaultNotes.get('Projects/Blue folder.md').text, /tower drawings/);
    const writes = companion.requests.filter(request => request.path === '/v1/obsidian/write');
    for (const path of [...companion.vaultNotes.keys()].filter(key => key !== 'Projects/Blue folder.md')) {
      assert.ok(path.startsWith('Nex Copilot/'), `only the copilot's folder is written (${path})`);
    }
    assert.ok(writes.length === 0 || companion.vaultNotes.size > 1, 'what was written is in the vault');

    await extension.clickOn(settings, 'Disconnect vault');
    await settings.waitForSelector('[data-vault="brain-pick"]', { timeout: 10000 }).catch(async error => {
      const seen = companion.requests
        .map(request => request.path)
        .slice(-8)
        .join('; ');
      throw new Error(`${error.message}. Shown: ${await text(settings)}. Last requests: ${seen}`);
    });
    assert.equal(companion.chosenVault(), null);
  } finally {
    await settings.close();
  }
});

test('Calendar: asks macOS for access, lists the calendars and reads the next meeting from the Mac', async () => {
  const start = Date.now() + 20 * 60_000;
  companion.calendar.events = [
    {
      id: 'mac-1@1',
      calendarId: 'cal-work',
      calendar: 'Work',
      title: 'Workspace review',
      start,
      end: start + 30 * 60_000,
      allDay: false,
      location: '',
      notes: 'Join https://meet.google.com/abc-defg-hij',
      url: null,
      joinUrl: 'https://meet.google.com/abc-defg-hij',
    },
  ];
  const settings = await extension.openSettings('#connections/calendar');
  try {
    await settings.waitForSelector('[data-calendar-mac="needs_permission"]', { timeout: 15000 });
    assert.match(await text(settings), /Privacy & Security › Calendars/);
    await extension.clickOn(settings, 'Allow access');
    await settings.waitForSelector('[data-calendar-mac="ready"]', { timeout: 15000 });
    assert.match(await text(settings), /avi@nexprove\.com/);
    assert.match(await text(settings), /Internet Accounts/);

    const upcoming = await until(async () => {
      const value = await extension.getStorage('calendar-upcoming');
      return value?.source === 'mac' && value.events.length ? value : null;
    }, 'the next meeting was read from the Mac');
    assert.equal(upcoming.events[0].title, 'Workspace review');
    assert.equal(upcoming.events[0].joinUrl, 'https://meet.google.com/abc-defg-hij');

    // Unticking a calendar keeps it out of the next read
    await settings.evaluate(() => {
      const box = [...document.querySelectorAll('[data-calendar-mac] label')].find(label =>
        label.innerText.includes('Home'),
      );
      box.querySelector('input').click();
    });
    await until(
      async () => companion.calendar.eventRequests.at(-1)?.calendarIds?.join(',') === 'cal-work',
      'only the ticked calendars are asked for',
    );
  } finally {
    await settings.close();
  }
});
