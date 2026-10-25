// Memory and settings that survive an uninstall: one browser backs up to a mock Ava Brain from Settings › Memory ›
// Backups; a second browser with a fresh profile (a reinstall: same extension ID, nothing stored) restores it from
// the first screen of the setup, pairing with the code on the way, and comes back with the chat, the settings and
// the model, with the setup done.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension, sleep } from './harness.mjs';
import { startMockCompanion } from './mock-companion.mjs';
import { startMockLlm } from './mock-llm.mjs';

const THREAD_ID = 'backup-e2e-thread';
const SECTION = 'section[aria-label="Backups on your Mac"]';

let mock;
let companion;

before(async () => {
  mock = await startMockLlm({});
  companion = await startMockCompanion();
});

after(async () => {
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

function idb(page, store, write) {
  return page.evaluate(
    (store, write) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(store, write ? 'readwrite' : 'readonly');
          const request = write ? tx.objectStore(store).put(write) : tx.objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          tx.oncomplete = () => open.result.close();
        };
      }),
    store,
    write ?? null,
  );
}

test('backs up this browser to Ava Brain from Settings, keys apart from the snapshot', async () => {
  const extension = await launchExtension(mock);
  try {
    const page = extension.options;
    await idb(page, 'threads', {
      id: THREAD_ID,
      title: 'Remember the blue folder',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      boundTabIds: [],
      pinned: false,
      archived: false,
      tags: [],
    });
    await extension.setStorage({ 'e2e-marker': { kept: true } });
    // The harness writes the model's key in storage; the background moves it into the vault on start
    await until(
      async () => (await extension.getStorage('llm-api-keys'))?.providers?.mock?.keyRef,
      'the key is in the vault',
    );
    // Commands come from the panel's own page
    const panel = await extension.browser.newPage();
    await panel.goto(`${extension.origin}/sidepanel.html`);
    await panel.waitForSelector('textarea', { timeout: 15000 });
    await command(panel, { type: 'brain_pair', code: companion.code, port: companion.port });

    const settings = await extension.openSettings('#memory/backups');
    await settings.waitForSelector(SECTION, { timeout: 10000 });
    await settings.evaluate(selector => {
      const button = [...document.querySelector(selector).querySelectorAll('button')].find(
        b => b.innerText.trim() === 'Back up now',
      );
      button.click();
    }, SECTION);
    await until(async () => companion.backups.size === 1, 'a snapshot reached Ava Brain').catch(async error => {
      const shown = await settings.evaluate(selector => document.querySelector(selector)?.innerText ?? '', SECTION);
      const seen = companion.requests.map(request => `${request.method} ${request.path}`).join('; ');
      throw new Error(`${error.message}. Section: ${shown}. Requests: ${seen}`);
    });
    await settings.waitForFunction(
      selector => /Last backup/.test(document.querySelector(selector)?.innerText ?? ''),
      { polling: 300, timeout: 15000 },
      SECTION,
    );
    const [entry] = companion.backups.values();
    assert.ok(entry.meta.counts.threads >= 1, 'the chat is in it');
    const secrets = companion.backupSecrets() ?? {};
    assert.ok(
      Object.keys(secrets).some(ref => ref.startsWith('llm:')),
      `the model key went to the Keychain side (kept: ${Object.keys(secrets).join(', ')}; requests: ${companion.requests
        .map(request => `${request.method} ${request.path}`)
        .join('; ')})`,
    );
    assert.ok(!Object.hasOwn(secrets, 'companion:token'), 'the pairing token never leaves');
    // Listed in the section, newest first
    await settings.waitForFunction(
      selector => /1 chats|chats/.test(document.querySelector(selector)?.innerText ?? ''),
      { polling: 300, timeout: 10000 },
      SECTION,
    );
  } finally {
    await extension.close();
  }
});

test('a reinstall restores it from the first screen of the setup', async () => {
  assert.equal(companion.backups.size, 1, 'the first test left a backup');
  const extension = await launchExtension(mock, { onboarding: true, model: false });
  try {
    const panel = await extension.browser.newPage();
    await panel.setViewport({ width: 400, height: 760 });
    await panel.goto(`${extension.origin}/sidepanel.html`);
    await panel.bringToFront();
    // The port of the mock (Ava Brain's own port is the default); nothing else is set up
    await command(panel, { type: 'brain_set_port', port: companion.port });
    const text = async () => (await panel.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');

    await panel.waitForSelector('[data-testid="onboard-restore"]', { timeout: 15000 });
    await panel.click('[data-testid="onboard-restore"]');
    await panel.waitForSelector('#restore-code', { timeout: 15000 });
    await panel.type('#restore-code', 'abcd2345');
    await panel.evaluate(() =>
      [...document.querySelectorAll('[data-testid="restore-from-brain"] button')]
        .find(b => b.innerText.trim() === 'Pair')
        .click(),
    );
    await until(async () => /Choose the backup/.test(await text()), 'the backups are listed');
    await panel.evaluate(() =>
      [...document.querySelectorAll('[data-testid="restore-from-brain"] button')]
        .find(b => b.innerText.trim() === 'Restore')
        .click(),
    );
    await panel.waitForSelector('[data-testid="backup-confirm"]', { timeout: 5000 });
    await panel.click('[data-testid="backup-confirm"]');
    // The restore is written before the panel hears back, and the extension restarts 1.2 s after: what came back
    // is read in the same step that sees "Restored". (The restart itself cannot be watched here: a browser started
    // with --load-extension does not bring the extension back after chrome.runtime.reload.)
    let last = '';
    const seen = await until(async () => {
      const now = await panel.evaluate(
        async threadId => ({
          text: document.body.innerText.replace(/\s+/g, ' '),
          stored: await chrome.storage.local.get(['e2e-marker', 'onboarding', 'brain-settings', 'llm-api-keys']),
          thread: await new Promise(resolve => {
            const open = indexedDB.open('avi-copilot');
            open.onsuccess = () => {
              const request = open.result.transaction('threads').objectStore('threads').get(threadId);
              request.onsuccess = () => {
                resolve(request.result ?? null);
                open.result.close();
              };
            };
          }),
        }),
        THREAD_ID,
      );
      last = now.text;
      return /Restored/.test(now.text) ? now : null;
    }, 'it says it restored').catch(error => {
      throw new Error(`${error.message}. Panel: ${last.slice(0, 800)}`);
    });
    assert.equal(seen.thread?.title, 'Remember the blue folder', 'the chat is back');
    const { stored } = seen;
    assert.deepEqual(stored['e2e-marker'], { kept: true });
    assert.ok(stored.onboarding?.completedAt > 0, 'the setup is done: the model came back');
    assert.equal(stored['brain-settings']?.paired, true, 'still paired with this Mac');
    assert.ok(stored['llm-api-keys']?.providers?.mock, 'the model is back');
  } finally {
    await extension.close();
  }
});
