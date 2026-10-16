import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { startMockMcp } from './mock-mcp.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of getting things connected (Profile menu › Connectors): the Obsidian vault in Brave, which
 * ships with the folder picker off (the panel says how to turn it on, instead of a button that does nothing), and
 * with a picker (the browser's private folder stands in for the vault); a server added with no sign-in that asks
 * for one (switched to signing in, and signed in at once); sign out and reconnect; "Set it up with Ava" from the
 * panel (the sign-in opens in an ordinary tab, the user's to finish, and the background carries on when the
 * service answers); and the same from the chat with the set_up_connection action. mock-mcp.mjs is the server.
 *
 * E2E_SHOTS=<dir> also saves screenshots of the panel at 400 px.
 */

const shots = process.env.E2E_SHOTS;
const scenarios = {
  'setup-chat': [
    () => [
      { set_up_connection: { intent: 'Connect the server', service: 'custom', url: mcpOauthUrl(), provider: '' } },
    ],
    () => [{ done: { text: 'Log in on the tab I opened, then tell me.', success: true } }],
  ],
  'setup-chat-again': [
    () => [{ set_up_connection: { intent: 'Carry on', service: 'custom', url: mcpOauthUrl(), provider: '' } }],
    () => [{ done: { text: 'All set.', success: true } }],
  ],
};

let mock;
let mcp;
let extension;
let session;
const mcpOauthUrl = () => mcp.oauthUrl;

before(async () => {
  mock = await startMockLlm(scenarios);
  mcp = await startMockMcp();
  extension = await launchExtension(mock);
  session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 1100 });
});

after(async () => {
  await session?.close().catch(() => {});
  await extension?.close();
  await mcp?.close();
  await mock?.close();
});

async function until(check, what, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(250);
  }
  const panel = session ? (await session.panelText()).slice(0, 900) : '';
  throw new Error(`Timed out waiting for ${what}. Last: ${JSON.stringify(last)?.slice(0, 300)}. Panel: ${panel}`);
}

async function shot(name) {
  if (!shots) return;
  await session.panel.bringToFront();
  await sleep(300);
  await session.panel.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
}

function clickByName(label, scope = 'body') {
  return session.panel.evaluate(
    (label, scope) => {
      const root = document.querySelector(scope);
      const element = [...(root?.querySelectorAll('button, [role="menuitem"], [role="radio"]') ?? [])].find(
        el => el.innerText?.trim() === label || el.getAttribute('aria-label') === label,
      );
      element?.click();
      return Boolean(element);
    },
    label,
    scope,
  );
}

function fill(selector, value) {
  return session.panel.evaluate(
    (selector, value) => {
      const input = document.querySelector(selector);
      if (!input) throw new Error(`No input ${selector}`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    value,
  );
}

function readStore(store) {
  return session.panel.evaluate(
    store =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          let all;
          try {
            all = open.result.transaction(store).objectStore(store).getAll();
          } catch (error) {
            open.result.close();
            return reject(error);
          }
          all.onsuccess = () => {
            resolve(all.result);
            open.result.close();
          };
          all.onerror = () => reject(all.error);
        };
      }),
    store,
  );
}

async function openConnectors() {
  await session.panel.bringToFront();
  if (await session.panel.evaluate(() => document.querySelector('[data-place="connectors"]') !== null)) {
    // Back to the list, from a connector's page
    await clickByName('Back to connectors');
    return;
  }
  await clickByName('Menu');
  await sleep(300);
  await session.openAccountMenu();
  await until(() => clickByName('Connectors'), 'Connectors in the profile menu');
  await session.panel.waitForSelector('[data-place="connectors"]', { timeout: 10000 });
}

/** Leaves the connectors place and comes back, so its pages render again (after a stub changes the window). */
async function reopenConnectors() {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await until(() => clickByName('New chat'), 'New chat in the drawer');
  await session.panel.waitForSelector('textarea', { timeout: 10000 });
  await openConnectors();
}

const pageTargets = () =>
  extension.browser
    .targets()
    .filter(target => target.type() === 'page')
    .map(target => target.url());

test('in Brave, with folder access off, the vault says how to turn it on and opens the setting', async () => {
  const brave = await session.panel.evaluate(() => Boolean(navigator.brave));
  await openConnectors();
  await session.panel.waitForSelector('[data-connections-obsidian] [data-vault="none"]', { timeout: 10000 });
  if (!brave) return;
  // Before this fix the button was there and a click did nothing (the picker does not exist in Brave)
  assert.equal(await session.panel.evaluate(() => document.querySelector('[data-vault-brave]') !== null), true);
  assert.equal(
    await session.panel.evaluate(() =>
      [...document.querySelectorAll('[data-connections-obsidian] button')].some(
        b => b.innerText.trim() === 'Choose vault',
      ),
    ),
    false,
  );
  await shot('obsidian-brave');
  assert.ok(await clickByName("Open Brave's setting"));
  await until(() => pageTargets().some(url => url.includes('flags/#file-system-access-api')), 'the flags page');

  // "Set it up with Ava" says the same and opens the setting too
  assert.ok(await clickByName('Set up Obsidian with Ava'));
  await session.panel.waitForSelector('[data-setup="obsidian"][data-setup-stage="obsidian_enable"]', {
    timeout: 10000,
  });
  assert.match(await session.panelText(), /File System Access API/);
  await shot('obsidian-brave-guide');
  assert.ok(await clickByName('Close the setup'));
});

test('with a folder picker, choosing the vault connects it, syncs, and the guide is done', async () => {
  // The browser's private folder stands in for the folder the user picks, with one note of their own in it
  await session.panel.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const vault = await root.getDirectoryHandle('picked-vault', { create: true });
    const folder = await vault.getDirectoryHandle('Nexprove', { create: true });
    const writable = await (await folder.getFileHandle('Roadmap.md', { create: true })).createWritable();
    await writable.write('Ship the connectors fix this week.');
    await writable.close();
    window.__picked = 0;
    window.showDirectoryPicker = async () => {
      window.__picked += 1;
      return vault;
    };
  });
  await reopenConnectors();
  assert.ok(await clickByName('Set up Obsidian with Ava'));
  await session.panel.waitForSelector('[data-setup="obsidian"][data-setup-stage="obsidian_pick"]', { timeout: 10000 });
  await shot('obsidian-pick');
  assert.ok(await clickByName('Choose vault', '[data-setup="obsidian"]'));
  await session.panel.waitForSelector('[data-setup="obsidian"][data-setup-stage="done"]', { timeout: 20000 });
  assert.equal(await session.panel.evaluate(() => window.__picked), 1);
  await until(
    () =>
      session.panel.evaluate(() =>
        /Wrote \d+ notes, read 1 of yours|Syncing when the panel/.test(document.body.innerText),
      ),
    'the first sync',
  );
  const note = await until(
    async () => (await readStore('kbItems')).find(item => item.sourceId === 'vault:Nexprove/Roadmap.md'),
    'the user’s note in memory',
  );
  assert.equal(note.workspaceId, 'nexprove');
  // The background's summary, which the chat's setup reads
  const state = await extension.getStorage('vault-state');
  assert.deepEqual(state, { support: 'ok', name: 'picked-vault', access: 'granted' });
  await shot('obsidian-done');
  assert.ok(await clickByName('Close the setup'));
});

test('a server added with no sign-in that asks for one is switched to signing in, and signs in at once', async () => {
  await openConnectors();
  assert.ok(await clickByName('Add custom server'));
  await session.panel.waitForSelector('#conn-url', { timeout: 5000 });
  await fill('#conn-name', 'Asks to sign in');
  await fill('#conn-url', mcp.oauthUrl);
  // "None" is the default sign-in; the default workspace is ticked already
  assert.equal(
    await session.panel.evaluate(() =>
      [...document.querySelectorAll('[role="checkbox"]')]
        .find(el => el.innerText.trim() === 'Nexprove')
        ?.getAttribute('aria-checked'),
    ),
    'true',
  );
  await clickByName('Add connector', 'form');
  await session.panel.waitForSelector('[data-connector="Asks to sign in"] [data-connector-status="connected"]', {
    timeout: 30000,
  });
  await until(() => session.panel.evaluate(() => document.querySelectorAll('[data-tool]').length === 6), 'its tools');
  const connector = (await readStore('connectors')).find(item => item.name === 'Asks to sign in');
  assert.equal(connector.authKind, 'oauth');
  assert.deepEqual(connector.workspaceIds, ['nexprove']);
  // A connector that never worked is not "signed out": no Inbox alert to sign in again
  const inbox = await readStore('inbox');
  assert.ok(!inbox.some(item => JSON.stringify(item).includes('Asks to sign in')), 'no alert in the Inbox');
  await shot('connector-switched');
});

test('signing out and reconnecting', async () => {
  assert.ok(await clickByName('Sign out'));
  await session.panel.waitForSelector('[data-connector="Asks to sign in"] [data-connector-status="needs_auth"]', {
    timeout: 10000,
  });
  assert.ok(await clickByName('Sign in'));
  await session.panel.waitForSelector('[data-connector="Asks to sign in"] [data-connector-status="connected"]', {
    timeout: 30000,
  });
  assert.equal(mcp.oauth.exchanges.length, 2);
  // Remove it, so the guided setup below starts from nothing
  assert.ok(await clickByName('Remove connector'));
  await sleep(200);
  assert.ok(await clickByName('Remove connector', '[role="alert"]'));
  await until(async () => (await readStore('connectors')).every(item => item.name !== 'Asks to sign in'), 'removal');
});

test('"Set it up with Ava" in the panel: adds the server, opens its sign-in in a tab, and carries on', async () => {
  await openConnectors();
  const tabsBefore = pageTargets().length;
  assert.ok(await clickByName('Set up Custom server with Ava'));
  await session.panel.waitForSelector('[data-setup="custom"][data-setup-stage="needs_url"]', { timeout: 10000 });
  await shot('guide-url');
  await fill('#setup-url', mcp.oauthUrl);
  await clickByName('Next', '[data-setup="custom"]');
  // The sign-in opens in an ordinary tab; the mock service answers at once, as if the user approved, and the
  // background closes the tab and finishes the sign-in. The guide moves on by itself.
  await session.panel.waitForSelector('[data-setup="custom"][data-setup-stage="review_tools"]', { timeout: 30000 });
  assert.match(await session.panelText(), /connected with 6 tools/);
  await shot('guide-review');
  assert.ok(mcp.oauth.authorizeRequests.length >= 3);
  // The sign-in tab is gone again, and the redirect never reached a page
  await until(() => pageTargets().length <= tabsBefore, 'the sign-in tab closed');
  assert.ok(!pageTargets().some(url => url.includes('chromiumapp.org')));
  const connector = (await readStore('connectors')).find(item => item.url === mcp.oauthUrl);
  assert.equal(connector.status, 'connected');
  assert.deepEqual(connector.workspaceIds, ['nexprove']);
  // Tools wait for the user's choice: the guide hands over to the connector's page
  assert.ok(await clickByName('Choose its tools'));
  await session.panel.waitForSelector(`[data-connector="${connector.name}"]`, { timeout: 10000 });
  assert.ok(await clickByName('Remove connector'));
  await sleep(200);
  assert.ok(await clickByName('Remove connector', '[role="alert"]'));
  await until(async () => (await readStore('connectors')).every(item => item.url !== mcp.oauthUrl), 'removal');
});

test('from the chat: set_up_connection opens the sign-in, the chat hears when it is done, and carries on', async () => {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await until(() => clickByName('New chat'), 'New chat in the drawer');
  await session.panel.waitForSelector('textarea', { timeout: 10000 });
  mock.start('setup-chat');
  // The address is one the user typed: setup never takes one from a page or a file
  await session.send(`Run the scripted scenario setup-chat: connect ${mcp.oauthUrl}`);
  await session.waitForEnd(60000);
  // The tab answered (mock), the background finished the sign-in and told the chat
  await until(() => session.panelText().then(text => /is signed in, with 6 tools/.test(text)), 'the note in the chat');
  const step = mock.runs.get('setup-chat').navigatorCalls[1] ?? '';
  assert.match(step, /Tell the user: I opened .*sign-in in a new tab/);
  assert.match(step, /Leave those tabs to them/);

  await clickByName('Menu');
  await sleep(300);
  await until(() => clickByName('New chat'), 'New chat in the drawer');
  await session.panel.waitForSelector('textarea', { timeout: 10000 });
  mock.start('setup-chat-again');
  await session.send(`Run the scripted scenario setup-chat-again for ${mcp.oauthUrl}`);
  await session.waitForEnd(60000);
  const again = mock.runs.get('setup-chat-again').navigatorCalls[1] ?? '';
  assert.match(again, /waiting \(review_tools\)|finished/);
  const connector = (await readStore('connectors')).find(item => item.url === mcp.oauthUrl);
  assert.equal(connector.status, 'connected');
  assert.deepEqual(session.panelErrors, []);
  await shot('chat-setup');
});
