import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, readThreads, sleep, waitForThread } from './harness.mjs';

/**
 * End-to-end tests of the tab registry (#68): a task for a site that is already open in another window uses
 * that tab, the agent is told what is open by site, and find_tab leads it to a tab in another window.
 */

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const typeName = name => page => [
  { input_text: { intent: 'Fill the name', index: page.find('input', 'name'), text: name } },
];

let mock;
let extension;

// What the navigator was last shown in a scenario: the page state, with the results of its last actions
const lastState = name => mock.runs.get(name).navigatorCalls.at(-1);

const scenarios = {
  'reuse-tab': [typeName('Ada'), done],
  'find-it': [
    () => [{ find_tab: { intent: 'Look for the shop tab', query: 'shop.localhost' } }],
    () => {
      const found = /\{id: (\d+), site: shop\.localhost/.exec(lastState('find-it'));
      if (!found) throw new Error(`find_tab gave no shop tab: ${lastState('find-it').slice(-600)}`);
      return [{ switch_tab: { intent: 'Go to the shop tab', tab_id: Number(found[1]) } }];
    },
    typeName('Grace'),
    done,
  ],
  'after-find': [done],
};

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const task = name => `Run the scripted scenario ${name}.`;
const nameField = page => page.$eval('#name', input => input.value);

/** Opens the fixture as "shop.localhost" in a window of its own, behind the one the user is in. */
async function openShopWindow(session) {
  const url = mock.fixtureUrl.replace('127.0.0.1', 'shop.localhost');
  const place = await session.panel.evaluate(async url => {
    const window = await chrome.windows.create({ url, focused: false });
    return { windowId: window.id, tabId: window.tabs[0].id };
  }, url);
  const target = await extension.browser.waitForTarget(found => found.url().startsWith(url), { timeout: 15000 });
  const page = await target.page();
  await page.waitForSelector('#name');
  return { ...place, page };
}

const tabOf = (session, tabId) => session.panel.evaluate(tabId => chrome.tabs.get(tabId), tabId);

let shop;
let session;

test('a task for a site that is already open in another window uses that tab', async () => {
  mock.start('reuse-tab');
  session = await openSession(extension, mock);
  shop = await openShopWindow(session);

  // The user is on another page, in another window, and names the site
  await session.send(`Go to Shop and ${task('reuse-tab').toLowerCase()}`);
  await session.waitForEnd();
  const thread = await waitForThread(session.panel, 'reuse-tab', t => t.status === 'idle');

  assert.deepEqual(thread.boundTabIds, [shop.tabId], 'the task is bound to the tab that was already open');
  assert.equal(await nameField(shop.page), 'Ada', 'the work happened in the open shop tab');
  assert.equal(await nameField(session.web), '', 'the tab in front was left alone');
  assert.match(await session.panelText(), /Using the shop\.localhost tab you already have open\./);
  assert.equal((await tabOf(session, shop.tabId)).windowId, shop.windowId, 'the tab stayed in its own window');
});

test('the agent is told what is open by site, finds a tab in another window and works there', async () => {
  mock.start('find-it');
  await shop.page.$eval('#name', input => (input.value = ''));
  const second = await openSession(extension, mock);

  // No site is named: the task starts on the tab in front
  await second.send(task('find-it'));
  await second.waitForEnd();
  const thread = await waitForThread(second.panel, 'find-it', t => t.status === 'idle');

  const first = mock.runs.get('find-it').navigatorCalls[0];
  assert.match(first, /Other tabs the user has open, by site/);
  assert.match(
    first,
    /shop\.localhost: 1 tab, open (under 1 min|\d+ min), last used|shop\.localhost: 1 tab, open (under 1 min|\d+ min), in front now/,
  );
  // The tab in the other window is not listed one by one: find_tab is how its id is found
  assert.doesNotMatch(first.split('Interactive elements')[0], new RegExp(`\\{id: ${shop.tabId},`));

  assert.equal(await nameField(shop.page), 'Grace', 'the agent moved to the shop tab and worked there');
  assert.ok(thread.boundTabIds.includes(shop.tabId), 'the shop tab joined the task');

  // A follow-up groups the chat's tabs: the tab from the other window must not be pulled across
  mock.start('after-find');
  await second.send(task('after-find'));
  await waitForThread(second.panel, 'find-it', t => t.status === 'running');
  await waitForThread(second.panel, 'find-it', t => t.status === 'idle' && t.boundTabIds.length === 2, 60000);
  await sleep(500);
  assert.equal((await tabOf(second, shop.tabId)).windowId, shop.windowId, 'the tab stayed in its own window');
  const threads = await readThreads(second.panel);
  assert.equal(threads.filter(t => t.status === 'error').length, 0);
});
