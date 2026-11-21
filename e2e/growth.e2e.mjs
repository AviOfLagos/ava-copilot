import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { startMockSuture } from './mock-suture.mjs';
import { launchExtension, openSession, readThreads, sleep } from './harness.mjs';

/**
 * End-to-end tests of the growth numbers (#70): a product's numbers read "not connected" with the reason, never
 * zero, while its API is off, has no token or refuses it; once connected, sign-ups can be asked for by source;
 * a changed answer is "no reading"; and make_link tags a link to the product.
 */

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];

const scenarios = {
  'ask-signups': [
    () => [{ metrics_query: { intent: 'Sign-ups by source', metric: 'signups', days: 2, by: 'channel' } }],
    done,
  ],
  'ask-while-off': [() => [{ metrics_query: { intent: 'Sign-ups today', metric: 'signups' } }], done],
  'tag-link': [
    () => [
      {
        make_link: {
          intent: 'A link for the launch post',
          url: 'https://rocketshop.test/pricing',
          source: 'X',
          medium: 'social',
          campaign: 'Launch Week',
        },
      },
    ],
    done,
  ],
};

let mock;
let suture;
let extension;
let session;

before(async () => {
  mock = await startMockLlm(scenarios);
  suture = await startMockSuture();
  extension = await launchExtension(mock);
  session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 1600 });
});

after(async () => {
  await session?.close().catch(() => {});
  await extension?.close();
  await suture?.close();
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
  throw new Error(`Timed out waiting for ${what}. Panel: ${(await session.panelText()).slice(0, 800)}`);
}

function clickByName(label) {
  return session.panel.evaluate(label => {
    const element = [...document.querySelectorAll('button, [role="menuitem"]')].find(
      el => el.innerText?.trim() === label || el.getAttribute('aria-label') === label,
    );
    element?.click();
    return Boolean(element);
  }, label);
}

function fillField(label, value) {
  return session.panel.evaluate(
    (label, value) => {
      document.querySelectorAll('details').forEach(group => (group.open = true));
      const field = [...document.querySelectorAll('label')]
        .find(el => el.innerText.trim().startsWith(label))
        ?.querySelector('input, textarea');
      if (!field) throw new Error(`No field "${label}"`);
      const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    },
    label,
    value,
  );
}

const textOf = testId =>
  session.panel.evaluate(testId => document.querySelector(`[data-testid="${testId}"]`)?.innerText ?? '', testId);

async function openWorkspace(name) {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await session.openAccountMenu();
  await until(() => clickByName('Workspaces'), 'Workspaces in the profile menu');
  await until(() => session.panel.evaluate(() => document.body.innerText.includes('Add workspace')), 'the list');
  if (!name) return;
  await until(
    () =>
      session.panel.evaluate(name => {
        const row = [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(name));
        row?.click();
        return Boolean(row);
      }, name),
    `the workspace ${name}`,
  );
  await session.panel.waitForSelector('[data-testid="product-numbers"]');
}

/** Presses "Read now" and waits for the status line to settle on something new. */
async function readNow(expecting) {
  assert.ok(await clickByName('Read now'));
  return until(async () => {
    const line = await textOf('numbers-status');
    return expecting.test(line) ? line : null;
  }, `the status ${expecting}`);
}

async function saveToken(value) {
  await fillField('API token', value);
  assert.ok(await until(() => clickByName('Save token'), 'the Save token button'));
  await sleep(600);
}

async function newChatSaying(text, scenario) {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await until(() => clickByName('New chat'), 'New chat');
  await session.panel.waitForSelector('textarea', { timeout: 10000 });
  mock.start(scenario);
  await session.send(text);
  await until(
    async () => (await readThreads(session.panel)).find(item => item.title?.startsWith(text.slice(0, 20))),
    `the chat "${text}"`,
  );
  await session.waitForEnd(30000);
}

const inbox = () =>
  session.panel.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('inbox').objectStore('inbox').getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        };
      }),
  );

test('a product with an API but no token reads "not connected", and today\'s sign-ups read "no reading"', async () => {
  await openWorkspace();
  assert.ok(await clickByName('Add workspace'));
  await fillField('Name', 'Rocket Shop');
  await fillField('Words that mean', 'rocket shop');
  assert.ok(await clickByName('Add the product this workspace sells'));
  await session.panel.waitForSelector('[data-testid="product-fields"]');
  await fillField('Site', 'https://rocketshop.test');
  await fillField('Numbers API address', suture.baseUrl);
  assert.ok(await clickByName('Save'));
  await until(async () => (await extension.getStorage('products'))?.items?.['rocket-shop'], 'the product to be saved');

  await openWorkspace('Rocket Shop');
  assert.match(await until(() => textOf('numbers-status'), 'a status line'), /Not read yet\./);
  assert.match(await readNow(/Not connected/), /No token for the product’s numbers API is saved/);
  assert.match(await textOf('numbers-signups'), /Sign-ups today \(UTC\): no reading/);
  assert.equal(suture.state.requests.length, 0, 'with no token, nothing is sent');
});

test('a refused token and an API that is off each say so, and one Inbox item is made per reason', async () => {
  await saveToken(`wrong-token-${'y'.repeat(32)}`);
  assert.match(await readNow(/refused the token/), /Not connected: The product refused the token/);
  // The token is shown only as its last characters
  assert.match(await session.panelText(), /Saved: ••••yyyy/);
  assert.doesNotMatch(await session.panelText(), /wrong-token/);

  suture.state.mode = 'off';
  assert.match(await readNow(/switched off/), /Not connected: The product’s API is switched off on its side/);
  // Asking twice does not make a second notice for the same reason
  assert.ok(await clickByName('Read now'));
  await sleep(1500);
  assert.match(await textOf('numbers-signups'), /no reading/);

  const notices = (await inbox()).filter(item => /the numbers are not connected/.test(item.title));
  assert.deepEqual(notices.map(item => item.externalId.split(':')[3]).sort(), [
    'agent_api_off',
    'no_token',
    'unauthorized',
  ]);
  assert.ok(notices.every(item => item.workspaceId === 'rocket-shop' && /will not show 0/.test(item.body)));
  // No cookie ever went with a request, only the bearer token
  assert.ok(suture.state.requests.every(request => request.cookie === null));
});

test('an agent asked for sign-ups while it is off is told there is no number, not zero', async () => {
  await newChatSaying('Rocket Shop sign-ups today? Run the scripted scenario ask-while-off.', 'ask-while-off');
  const told = mock.runs.get('ask-while-off').navigatorCalls[1];
  assert.match(told, /Rocket Shop · signups · \d{4}-\d{2}-\d{2} \(UTC days\)/);
  assert.match(told, /Not connected: The product's agent API is switched off/);
  assert.match(told, /Do not say 0/);
  assert.doesNotMatch(told, /Total:/);
});

test("with the right token the numbers are read, and yesterday's sign-ups can be asked for by source", async () => {
  const today = suture.today();
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  suture.state.mode = 'ok';
  suture.state.signups = {
    [yesterday]: [['producthunt', 'launch-week'], ['producthunt', 'launch-week'], ['x', 'thread-1'], ['(direct)']],
    [today]: [['x', 'thread-1'], ['(direct)'], ['(direct)']],
  };
  await openWorkspace('Rocket Shop');
  await saveToken(suture.state.token);
  assert.match(await readNow(/^Connected\./), /Connected\. Last read /);
  assert.match(await textOf('numbers-signups'), /Sign-ups today \(UTC\): 3/);

  await newChatSaying('Rocket Shop sign-ups by source. Run the scripted scenario ask-signups.', 'ask-signups');
  const told = mock.runs.get('ask-signups').navigatorCalls[1];
  assert.match(told, /Total: 7 over 2 of 2 days/);
  assert.match(told, /By channel: \(direct\) 3; producthunt 2; x 2/);
  assert.match(told, new RegExp(`By day: ${yesterday} 4; ${today} 3`));
  assert.match(told, /Read: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
});

test('an answer in a shape nobody expects is "no reading", not a wrong number', async () => {
  suture.state.mode = 'odd';
  await openWorkspace('Rocket Shop');
  // The numbers read before stay; the status says one could not be read
  assert.match(await readNow(/Connected, but/), /in a shape Ava does not know/);
  suture.state.mode = 'ok';
});

test('make_link tags a link to the product so a sign-up can be traced', async () => {
  await newChatSaying('Rocket Shop launch link. Run the scripted scenario tag-link.', 'tag-link');
  const told = mock.runs.get('tag-link').navigatorCalls[1];
  assert.match(told, /https:\/\/rocketshop\.test\/pricing\?utm_source=x&utm_medium=social&utm_campaign=launch-week/);
});
