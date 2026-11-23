import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * Tab-scoped chats: each tab has its own panel, a chat lives on the tab it was started on, and a step that would take
 * the user's page to another site opens a new tab instead.
 */

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];

// Another site than the fixture page (127.0.0.1): the same server under another name
let otherSite = '';
const scenarios = {
  'other-site': [() => [{ go_to_url: { intent: 'Go to the other site', url: otherSite } }], done],
  'just-finish': [done],
};

let mock;
let extension;
let worker;

before(async () => {
  mock = await startMockLlm(scenarios);
  otherSite = mock.fixtureUrl.replace('127.0.0.1', 'other.localhost') + '?other=1';
  extension = await launchExtension(mock);
  worker = await (
    await extension.browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(extension.origin))
  ).worker();
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const tabIdOf = url =>
  worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
const tabPanels = () =>
  worker.evaluate(async () => (await chrome.storage.session.get('tab-panels'))['tab-panels'] ?? {});

async function waitFor(check, what, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A session whose panel is the web tab's own panel, the way the toolbar button opens it. */
async function tabSession() {
  const session = await openSession(extension, mock);
  const tabId = await tabIdOf(session.web.url());
  assert.ok(tabId, 'the web page has a tab');
  await session.panel.goto(`${extension.origin}/sidepanel.html?tab=${tabId}`);
  await session.panel.waitForSelector('textarea');
  return { session, tabId };
}

test('a step to another site opens a new tab and leaves the user’s page as it was', async () => {
  mock.start('other-site');
  const { session, tabId } = await tabSession();
  const page = session.web.url();
  await session.send('Find the same thing on the other site');
  await session.waitForEnd();
  assert.deepEqual(mock.run.errors, [], 'the scripted model ran without errors');

  // The user's page never moved; the other site is in a tab of its own
  assert.equal(session.web.url(), page);
  const opened = await waitFor(() => tabIdOf(otherSite), 'the new tab on the other site');
  assert.notEqual(opened, tabId);

  // The chat lives on the tab it was sent from, and shows on the tab its run opened too
  const map = await waitFor(async () => {
    const value = await tabPanels();
    return value[String(opened)] ? value : null;
  }, 'the new tab to show the chat');
  const threadId = map[String(tabId)]?.threadId;
  assert.ok(threadId, 'the chat is bound to the tab it was sent from');
  assert.equal(map[String(tabId)].role, 'home');
  assert.deepEqual(map[String(opened)], { threadId, role: 'work' });
  const options = await worker.evaluate(id => chrome.sidePanel.getOptions({ tabId: id }), opened);
  assert.equal(options.enabled, true);
  assert.equal(options.path, `sidepanel.html?tab=${opened}`);
  // A tab with no chat of its own has no panel
  assert.equal((await worker.evaluate(() => chrome.sidePanel.getOptions({}))).enabled, false);

  await worker.evaluate(id => chrome.tabs.remove(id), opened);
  assert.deepEqual(session.panelErrors, [], 'the side panel threw no errors');
  await session.close();
});

test('a tab’s panel comes back to its chat and draft, and another tab can carry the chat on', async () => {
  mock.start('just-finish');
  const { session, tabId } = await tabSession();
  await session.send('Run the scripted scenario just-finish.');
  await session.waitForEnd();
  const threadId = await waitFor(async () => (await tabPanels())[String(tabId)]?.threadId, 'the chat on its tab');

  // A draft typed and left: the panel made anew (as Chrome may do on a tab switch) shows the chat and the draft
  await session.panel.evaluate(() => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'half a thought');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(800);
  await session.panel.reload();
  await waitFor(
    () => session.panel.evaluate(() => document.querySelector('textarea')?.value === 'half a thought'),
    'the draft to come back',
  );
  await waitFor(
    async () => /Run the scripted scenario just-finish/.test(await session.panelText()),
    'the chat to come back',
  );

  // A new tab starts fresh: "New conversation", or a past chat with the page it belongs to
  const other = await extension.browser.newPage();
  await other.goto(mock.fixtureUrl + '?second=1');
  const otherTab = await tabIdOf(other.url());
  const otherPanel = await extension.browser.newPage();
  await otherPanel.goto(`${extension.origin}/sidepanel.html?tab=${otherTab}`);
  await otherPanel.waitForSelector('textarea');
  const startText = await waitFor(async () => {
    const text = await otherPanel.evaluate(() => document.body.innerText);
    return /New conversation/.test(text) && /Run the scripted scenario just-finish/.test(text) ? text : null;
  }, 'the start screen with the past chat');
  assert.match(startText, /127\.0\.0\.1/, 'the past chat says which page it belongs to');

  // Opening it there binds it to that tab, and the first tab's panel says it moved
  await otherPanel.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => b.innerText.includes('Run the scripted scenario')).click();
  });
  await waitFor(async () => (await tabPanels())[String(otherTab)]?.threadId === threadId, 'the chat to move');
  assert.equal((await tabPanels())[String(tabId)], undefined);
  await waitFor(
    async () => /moved to another tab/.test(await session.panelText()),
    'the first panel to say the chat moved',
  );
  const thread = await worker.evaluate(
    id =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction('threads').objectStore('threads').get(id);
          request.onsuccess = () => resolve(request.result);
        };
      }),
    threadId,
  );
  assert.deepEqual(thread.boundTabIds, [otherTab]);

  await otherPanel.close();
  await other.close();
  await session.close();
});
