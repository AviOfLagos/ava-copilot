import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { startMockMcp, NOTE_MARKER, ORDER_MARKER } from './mock-mcp.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of connectors (remote MCP servers): the user adds a server in the panel (Profile menu ›
 * Connectors) and binds it to a workspace, its tools are listed as new and stay off until chosen; the agent
 * runs a read tool freely, a write tool only after the confirm card, gets a rate-limited read retried, gives up
 * on a slow tool at its time limit, refuses a tool whose description changed (the panel shows the change), and
 * hands an injection payload to the model wrapped as untrusted content. The scripted model (mock-llm.mjs)
 * decides the calls; mock-mcp.mjs is the server.
 */

const CONNECTOR = 'Mock tools';
const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const call = (tool, args) => () => [
  { call_tool: { intent: `Use ${tool}`, connector: CONNECTOR, tool, args: JSON.stringify(args) } },
];
const scenarios = {
  'tools-read': [call('lookup_order', { order_id: 'A-7' }), done],
  'tools-write': [call('send_message', { channel: '#launch', text: 'Ship it on Friday' }), done],
  'tools-flaky': [call('search_flaky', { query: 'launch' }), done],
  'tools-slow': [call('slow_report', {}), done],
  'tools-drift': [call('get_forecast', { city: 'Lisbon' }), done],
  'tools-inject': [call('fetch_notes', { order_id: 'A-7' }), done],
};

let mock;
let mcp;
let extension;
let session;
let worker;

before(async () => {
  mock = await startMockLlm(scenarios);
  mcp = await startMockMcp();
  extension = await launchExtension(mock);
  // The MCP SDK runs in the background: anything there needing eval would be refused by the extension's CSP. A
  // refused eval caught in a try leaves no console entry, so the worker's own violation events are counted
  const target = await extension.browser.waitForTarget(
    candidate => candidate.type() === 'service_worker' && candidate.url().startsWith(extension.origin),
  );
  worker = await target.worker();
  await worker.evaluate(() => {
    self.__csp = [];
    self.addEventListener('securitypolicyviolation', event => self.__csp.push(event.violatedDirective));
  });
  session = await openSession(extension, mock);
  await session.panel.evaluate(() => {
    window.__csp = [];
    window.addEventListener('securitypolicyviolation', event => window.__csp.push(event.violatedDirective));
  });
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
  const panel = session ? (await session.panelText()).slice(0, 700) : '';
  throw new Error(`Timed out waiting for ${what}. Last: ${JSON.stringify(last)?.slice(0, 300)}. Panel: ${panel}`);
}

function readStore(page, store) {
  return page.evaluate(
    store =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction(store).objectStore(store).getAll();
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

/** Clicks the first button or menu item whose text or accessible name is `label`, inside `scope` if given. */
function clickByName(label, scope = 'body') {
  return session.panel.evaluate(
    (label, scope) => {
      const root = document.querySelector(scope);
      const element = [...(root?.querySelectorAll('button, [role="menuitem"]') ?? [])].find(
        el => el.innerText?.trim() === label || el.getAttribute('aria-label') === label,
      );
      element?.click();
      return Boolean(element);
    },
    label,
    scope,
  );
}

/** Types into a React-controlled input, as a user would. */
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

async function openConnectors() {
  await session.panel.bringToFront();
  if (await session.panel.evaluate(() => document.querySelector('[data-place="connectors"]') !== null)) return;
  await clickByName('Menu');
  await sleep(300);
  await session.openAccountMenu();
  await until(() => clickByName('Connectors'), 'Connectors in the profile menu');
  await session.panel.waitForSelector('[data-place="connectors"]', { timeout: 10000 });
}

const toolState = tool =>
  session.panel.evaluate(
    tool => document.querySelector(`[data-tool="${tool}"]`)?.getAttribute('data-tool-state'),
    tool,
  );

async function choose(tool, policy) {
  await session.panel.evaluate(
    (tool, policy) => document.querySelector(`[data-tool="${tool}"] [data-policy="${policy}"]`).click(),
    tool,
    policy,
  );
  await sleep(150);
  // Running freely when the server does not even claim the tool only reads takes a second click
  await session.panel.evaluate(
    tool => document.querySelector(`[data-tool="${tool}"] [data-confirm-read]`)?.click(),
    tool,
  );
  await until(
    () =>
      session.panel.evaluate(
        (tool, policy) =>
          document.querySelector(`[data-tool="${tool}"] [data-policy="${policy}"]`)?.getAttribute('aria-checked') ===
          'true',
        tool,
        policy,
      ),
    `${tool} set to ${policy}`,
  );
}

/** A new chat, from the drawer: the composer only shows on Home and in a chat. */
async function newChat() {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await until(() => clickByName('New chat'), 'New chat in the drawer');
  await session.panel.waitForSelector('textarea', { timeout: 10000 });
}

/** Runs a scripted scenario in a new chat and waits for it to end; returns the panel text. */
async function runScenario(name) {
  await newChat();
  mock.start(name);
  await session.send(`Run the scripted scenario ${name}`);
  return session.waitForEnd(60000);
}

/** The text the model was sent on the step after the tool ran (where action results show). */
const afterToolCall = name => (mock.runs.get(name)?.navigatorCalls ?? [])[1] ?? '';

test('a remote MCP server is added, bound to a workspace, and its tools listed as new and off', async () => {
  await openConnectors();
  assert.ok(await clickByName('Add custom server'), 'the custom server form opens');
  await session.panel.waitForSelector('#conn-url', { timeout: 5000 });
  await fill('#conn-name', CONNECTOR);
  await fill('#conn-url', mcp.url);
  await until(
    () =>
      session.panel.evaluate(() => {
        const chip = [...document.querySelectorAll('[role="checkbox"]')].find(el => el.innerText.trim() === 'Nexprove');
        if (chip?.getAttribute('aria-checked') !== 'true') chip?.click();
        return Boolean(chip);
      }),
    'the Nexprove workspace chip',
  );
  await clickByName('More options');
  await session.panel.waitForSelector('#conn-timeout', { timeout: 5000 });
  await fill('#conn-timeout', '3');
  await clickByName('Add connector');

  await session.panel.waitForSelector(`[data-connector="${CONNECTOR}"]`, { timeout: 30000 });
  await until(
    () => session.panel.evaluate(() => document.querySelectorAll('[data-tool]').length === 6),
    'the six tools listed',
  );
  const states = await session.panel.evaluate(() =>
    [...document.querySelectorAll('[data-tool]')].map(el => el.getAttribute('data-tool-state')),
  );
  assert.deepEqual([...new Set(states)], ['new']);
  assert.match(await session.panelText(), /6 waiting for you/);

  const [connector] = await readStore(session.panel, 'connectors');
  assert.equal(connector.name, CONNECTOR);
  assert.deepEqual(connector.workspaceIds, ['nexprove']);
  assert.equal(connector.status, 'connected');
  assert.equal(connector.transport, 'streamable_http');
  assert.equal(connector.timeoutMs, 3000);
  const fingerprints = await readStore(session.panel, 'toolFingerprints');
  assert.equal(fingerprints.length, 6);
  assert.ok(fingerprints.every(item => item.approved === false && /^[0-9a-f]{64}$/.test(item.hash)));
});

test('the user chooses per tool; one the server does not call read-only needs a second click to run freely', async () => {
  for (const tool of ['lookup_order', 'search_flaky', 'slow_report', 'get_forecast']) await choose(tool, 'read');
  await choose('send_message', 'approve');
  await choose('fetch_notes', 'read');
  for (const tool of ['lookup_order', 'send_message', 'fetch_notes']) assert.equal(await toolState(tool), 'ok');
  const [connector] = await readStore(session.panel, 'connectors');
  assert.deepEqual(connector.toolPolicy, {
    lookup_order: 'read',
    search_flaky: 'read',
    slow_report: 'read',
    get_forecast: 'read',
    send_message: 'approve',
    fetch_notes: 'read',
  });
});

test('a read tool runs from the agent without asking, and its answer reaches the model as untrusted data', async () => {
  const text = await runScenario('tools-read');
  assert.match(text, /E2E scenario finished/);
  assert.deepEqual(
    mcp.callsOf('lookup_order').map(item => item.args),
    [{ order_id: 'A-7' }],
  );
  const state = afterToolCall('tools-read');
  const block = state.slice(state.indexOf('<nano_untrusted_content>'), state.indexOf('</nano_untrusted_content>'));
  assert.ok(block.includes(ORDER_MARKER), 'the tool answer is inside the untrusted block');
  // The tools the chat may use, once agent/prompts/base.ts adds the [Connector tools] section to each step
  const first = mock.runs.get('tools-read').navigatorCalls[0];
  if (first.includes('[Connector tools]')) {
    assert.match(first, /Mock tools › lookup_order \(runs freely\): Look up an order by its number\. Args: order_id\*/);
    assert.match(first, /Mock tools › send_message \(asks the user first\)/);
    assert.ok(!first.includes('get_forecast (') || first.includes('get_forecast (runs freely)'));
  }
});

test('a write tool shows the confirm card with its arguments and runs only after the click', async () => {
  await newChat();
  mock.start('tools-write');
  await session.send('Run the scripted scenario tools-write');
  const card = await session.waitForCard();
  assert.match(card, /Mock tools › send_message/);
  assert.match(card, /#launch/);
  assert.match(card, /Ship it on Friday/);
  assert.equal(mcp.callsOf('send_message').length, 0, 'nothing is sent before the click');
  await session.panel.bringToFront();
  await session.answer('Confirm');
  await session.waitForEnd(60000);
  assert.deepEqual(
    mcp.callsOf('send_message').map(item => item.args),
    [{ channel: '#launch', text: 'Ship it on Friday' }],
  );
});

test('a read the server rate-limits is retried after Retry-After', async () => {
  await runScenario('tools-flaky');
  assert.equal(mcp.state.statuses.filter(status => status === 429).length, 1);
  assert.equal(mcp.callsOf('search_flaky').length, 1);
  assert.match(afterToolCall('tools-flaky'), /3 results for launch/);
});

test('a slow tool is given up at the connector’s time limit', async () => {
  await runScenario('tools-slow');
  assert.match(afterToolCall('tools-slow'), /did not answer within 3 s/);
});

test('a tool whose description changed is turned off, shown as changed, and not called', async () => {
  mcp.changeDescription();
  await openConnectors();
  if (
    !(await session.panel.evaluate(name => document.querySelector(`[data-connector="${name}"]`) !== null, CONNECTOR))
  ) {
    await session.panel.evaluate(name => document.querySelector(`[data-connector-row="${name}"]`)?.click(), CONNECTOR);
  }
  await session.panel.waitForSelector(`[data-connector="${CONNECTOR}"]`, { timeout: 10000 });
  assert.ok(await clickByName('Check tools'));
  await until(async () => (await toolState('get_forecast')) === 'changed', 'get_forecast shown as changed');
  const drift = await session.panel.evaluate(
    () => document.querySelector('[data-tool="get_forecast"] [data-drift]')?.innerText,
  );
  assert.match(drift, /changed since you approved it/);
  assert.match(drift, /Get the weather forecast for a city\./);

  await runScenario('tools-drift');
  assert.equal(mcp.callsOf('get_forecast').length, 0);
  assert.match(afterToolCall('tools-drift'), /changed since the user approved it/);
});

test('an injection payload from a tool arrives wrapped as untrusted, with its order blocked', async () => {
  await runScenario('tools-inject');
  const state = afterToolCall('tools-inject');
  const start = state.indexOf('<nano_untrusted_content>');
  const end = state.indexOf('</nano_untrusted_content>');
  assert.ok(start >= 0 && end > start, 'there is an untrusted block');
  const block = state.slice(start, end);
  assert.ok(block.includes(NOTE_MARKER), 'the tool answer is inside it');
  assert.ok(block.includes('[BLOCKED_OVERRIDE_ATTEMPT]'), 'the order in it is blocked');
  assert.ok(!state.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'));
  assert.deepEqual(session.panelErrors, []);
});

test('signing in with OAuth: launchWebAuthFlow, PKCE, the code traded by the background, tokens only in the vault', async () => {
  await openConnectors();
  if (!(await clickByName('Add custom server'))) {
    await clickByName('Back to connectors');
    assert.ok(await until(() => clickByName('Add custom server'), 'the custom server button'));
  }
  await session.panel.waitForSelector('#conn-url', { timeout: 5000 });
  await fill('#conn-name', 'Mock OAuth');
  await fill('#conn-url', mcp.oauthUrl);
  await session.panel.evaluate(() =>
    [...document.querySelectorAll('[role="radio"]')].find(el => el.innerText.trim() === 'Sign in')?.click(),
  );
  await until(
    () =>
      session.panel.evaluate(() => {
        const chip = [...document.querySelectorAll('[role="checkbox"]')].find(el => el.innerText.trim() === 'Nexprove');
        if (chip?.getAttribute('aria-checked') !== 'true') chip?.click();
        return Boolean(chip);
      }),
    'the Nexprove workspace chip',
  );
  await clickByName('Add connector');
  // Right after adding, the panel opens the sign-in page itself with chrome.identity.launchWebAuthFlow (the
  // click on "Add connector" asked for it); the shim sends it straight back
  await session.panel.waitForSelector('[data-connector="Mock OAuth"] [data-connector-status="connected"]', {
    timeout: 30000,
  });
  await until(
    () => session.panel.evaluate(() => document.querySelectorAll('[data-tool]').length === 6),
    'the tools behind the sign-in',
  );

  const extensionId = new URL(extension.origin).host;
  const [authorize] = mcp.oauth.authorizeRequests;
  assert.equal(authorize.redirect_uri, `https://${extensionId}.chromiumapp.org/`);
  assert.equal(authorize.code_challenge_method, 'S256');
  assert.equal(authorize.resource, mcp.oauthUrl);
  assert.ok(authorize.state.length >= 40);
  assert.deepEqual(mcp.oauth.exchanges, [{ grant: 'authorization_code', verified: true, resource: mcp.oauthUrl }]);

  // The token is in the encrypted vault, nowhere a page or content script could read it
  const local = JSON.stringify(await session.panel.evaluate(() => chrome.storage.local.get(null)));
  const sessionArea = JSON.stringify(await session.panel.evaluate(() => chrome.storage.session.get(null)));
  assert.ok(!local.includes('mock-access') && !sessionArea.includes('mock-access'));
  const connectors = await readStore(session.panel, 'connectors');
  assert.ok(!JSON.stringify(connectors).includes('mock-access'));
  const oauthConnector = connectors.find(item => item.name === 'Mock OAuth');
  const vault = await session.panel.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-secrets');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('secrets').objectStore('secrets').getAll();
          all.onsuccess = () => {
            resolve(
              all.result.map(record => ({
                ref: record.ref,
                plain: new TextDecoder().decode(new Uint8Array(record.data)).includes('mock-access'),
              })),
            );
            open.result.close();
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
  assert.ok(vault.some(record => record.ref === `conn:${oauthConnector.id}:oauth`));
  assert.ok(vault.every(record => !record.plain));
});

test('"Add connector" at the top of the place opens the add-connector form (catalogue + custom URL)', async () => {
  await openConnectors();
  // openConnectors only guarantees `[data-place="connectors"]`, which also wraps the detail and add
  // sub-views; an earlier test may have left one of those open, so get back to the list first.
  if (!(await session.panel.evaluate(() => document.querySelector('[data-add-connector]') !== null))) {
    await clickByName('Back to connectors');
    await session.panel.waitForSelector('[data-add-connector]', { timeout: 10000 });
  }
  await session.panel.evaluate(() => document.querySelector('[data-add-connector]').click());
  await session.panel.waitForSelector('form[aria-labelledby="conn-add-title"]', { timeout: 10000 });
  // Back to the list, so later tests (and the CSP check) find the place they expect
  await clickByName('Back to connectors');
  await session.panel.waitForSelector('[data-add-connector]', { timeout: 10000 });
});

test('nothing the connectors do is refused by the extension’s content security policy', async () => {
  assert.deepEqual(await worker.evaluate(() => self.__csp), [], 'no violation in the background');
  assert.deepEqual(await session.panel.evaluate(() => window.__csp ?? []), [], 'no violation in the panel');
});
