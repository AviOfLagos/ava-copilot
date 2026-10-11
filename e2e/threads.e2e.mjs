import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, readThreads, restartServiceWorker, sleep, waitForThread } from './harness.mjs';

/**
 * End-to-end tests of threads: several running at once on their own tabs, tab locks, a closed tab,
 * a restarted service worker, history, branching and pop-out windows.
 */

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const typeName = name => page => [
  { input_text: { intent: 'Fill the name', index: page.find('input', 'name'), text: name } },
];
const slowly = (ms, step) => async page => {
  await sleep(ms);
  return step(page);
};
const writeMessage = text => page => [
  { input_text: { intent: 'Write the message', index: page.find('div', 'role=textbox'), text } },
];
const clickSend = page => [{ click_element: { intent: 'Send it', index: page.find('div', 'Send message') } }];

const scenarios = {
  'parallel-a': [typeName('Ada'), slowly(4000, done)],
  'parallel-b': [typeName('Bob'), slowly(1000, done)],
  'hold-tab': [slowly(6000, done)],
  'tab-thief': [done],
  'stop-me': [slowly(10000, done)],
  'close-my-tab': [writeMessage('Draft for later'), clickSend, done],
  'survive-restart': [writeMessage('Still here'), clickSend, clickSend, done],
  'first-task': [typeName('Grace'), done],
  'ws-task': [done],
  'second-task': [done],
  branchable: [typeName('Linus'), done],
};

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

const task = name => `Run the scripted scenario ${name}.`;

test('two threads run at once, each on its own tab, and one can be stopped alone', async () => {
  mock.start('parallel-a');
  mock.start('parallel-b');
  mock.start('stop-me');
  const a = await openSession(extension, mock);
  const b = await openSession(extension, mock);
  const c = await openSession(extension, mock);

  await a.send(task('parallel-a'));
  const threadA = await waitForThread(a.panel, 'parallel-a', t => t.status === 'running');
  await b.send(task('parallel-b'));
  const threadB = await waitForThread(b.panel, 'parallel-b', t => t.status === 'running');
  await c.send(task('stop-me'));
  await waitForThread(c.panel, 'stop-me', t => t.status === 'running');

  // All three run together, each bound to a different tab
  const running = (await readThreads(a.panel)).filter(t => t.status === 'running');
  assert.equal(running.length, 3);
  assert.equal(new Set(running.map(t => t.boundTabIds[0])).size, 3);

  // Stopping one leaves the others going
  await c.click('Stop');
  await waitForThread(c.panel, 'stop-me', t => t.status === 'idle');
  assert.equal((await readThreads(a.panel)).find(t => t.id === threadA.id).status, 'running');

  await a.waitForEnd();
  await b.waitForEnd();
  assert.equal(await a.web.$eval('#name', el => el.value), 'Ada');
  assert.equal(await b.web.$eval('#name', el => el.value), 'Bob');
  assert.notEqual(threadA.boundTabIds[0], threadB.boundTabIds[0]);
  for (const session of [a, b, c]) await session.close();
});

test('a tab held by a running thread is refused to another thread', async () => {
  mock.start('hold-tab');
  const holder = await openSession(extension, mock);
  await holder.send(task('hold-tab'));
  await waitForThread(holder.panel, 'hold-tab', t => t.status === 'running');

  // A second panel on the same page
  const thief = await openSession(extension, mock);
  await thief.web.close();
  thief.web = holder.web;
  await thief.send(task('tab-thief'));
  await thief.panel.waitForFunction(() => document.body.innerText.includes('Tab is in use by thread'), {
    timeout: 5000,
    polling: 300,
  });
  assert.match(await thief.panelText(), /Tab is in use by thread "Run the scripted scenario hold-tab\."/);

  await holder.waitForEnd();
  await holder.close();
  await thief.panel.close();
});

test('closing the tab of a running thread stops it, and it can reopen the page and continue', async () => {
  mock.start('close-my-tab');
  const session = await openSession(extension, mock);
  await session.send(task('close-my-tab'));
  await session.waitForCard();

  await session.web.close();
  const stopped = await waitForThread(session.panel, 'close-my-tab', t => t.status === 'error');
  assert.equal(stopped.error.kind, 'tab_closed');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Reopen and continue'), { polling: 300 });

  await session.click('Reopen and continue');
  const resumed = await waitForThread(session.panel, 'close-my-tab', t => t.status !== 'error');
  assert.notEqual(resumed.boundTabIds[0], stopped.boundTabIds[0]);
  const pages = await extension.browser.pages();
  assert.ok(
    pages.some(page => page.url().includes('/fixture.html')),
    'the page was reopened',
  );
  await session.panel.close();
});

test('a run survives the service worker being killed: it resumes and asks again, never replays', async () => {
  mock.start('survive-restart');
  const session = await openSession(extension, mock);
  await session.send(task('survive-restart'));
  const firstCard = await session.waitForCard();
  assert.match(firstCard, /Still here/);
  const before = await waitForThread(session.panel, 'survive-restart', t => t.status === 'waiting_confirm');

  await restartServiceWorker(extension, session.panel);

  // The new worker resumes the thread; the pending send did not happen and is asked for again
  const resumed = await waitForThread(
    session.panel,
    'survive-restart',
    t => t.status === 'waiting_confirm' && t.pendingRequest?.id !== before.pendingRequest.id,
  );
  assert.ok(resumed.pendingRequest);
  assert.deepEqual(await session.events(), [], 'nothing was sent across the restart');
  assert.match(await session.panelText(), /Resumed\./);

  await session.answer('Confirm');
  await session.waitForEnd();
  assert.deepEqual(await session.events(), [{ type: 'sent', text: 'Still here' }]);
  await session.close();
});

test('an earlier thread opens from the list with its history and continues with it', async () => {
  mock.start('first-task');
  const session = await openSession(extension, mock);
  await session.send(task('first-task'));
  await session.waitForEnd();

  // Leave the thread, then come back to it from the list
  await session.click('New thread');
  await session.click('Menu');
  await session.panel.waitForFunction(() => document.body.innerText.includes('first-task'), { polling: 300 });
  await session.click('Run the scripted scenario first-task.');
  await session.panel.waitForFunction(() => document.body.innerText.includes('E2E scenario finished'), {
    polling: 300,
  });

  mock.start('second-task');
  await session.send(task('second-task'));
  await session.panel
    .waitForFunction(() => (document.body.innerText.match(/E2E scenario finished/g) ?? []).length >= 2, {
      timeout: 30000,
      polling: 300,
    })
    .catch(async error => {
      throw new Error(`${error.message}. Panel: ${(await session.panelText()).slice(-600)}`);
    });
  // The follow-up ran with the earlier task in its model history
  assert.match(mock.runs.get('second-task').requests[0], /first-task/);
  const threads = (await readThreads(session.panel)).filter(t => t.title.includes('first-task'));
  assert.equal(threads.length, 1, 'the follow-up went to the same thread');
  await session.close();
});

test('a thread branches from a message into a new thread with the conversation up to it', async () => {
  mock.start('branchable');
  const session = await openSession(extension, mock);
  await session.send(task('branchable'));
  await session.waitForEnd();
  const original = await waitForThread(session.panel, 'branchable', t => t.status === 'idle' && !t.forkedFrom);

  await session.panel.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find(b => b.innerText.trim() === 'Branch from here' || b.getAttribute('aria-label') === 'Branch from here')
      .click();
  });
  const fork = await waitForThread(session.panel, 'branchable. (branch)');
  assert.deepEqual(fork.forkedFrom, { threadId: original.id, seq: 1 });
  await session.panel.waitForFunction(() => !document.body.innerText.includes('E2E scenario finished'), {
    polling: 300,
  });
  assert.match(await session.panelText(), /Run the scripted scenario branchable\./);
  await session.close();
});

test('a thread pops out into its own window', async () => {
  const session = await openSession(extension, mock);
  const thread = (await readThreads(session.panel)).find(t => t.title.includes('branchable') && !t.forkedFrom);
  await session.panel.goto(`${extension.origin}/sidepanel.html?thread=${thread.id}`);
  await session.panel.waitForFunction(() => document.body.innerText.includes('branchable'), { polling: 300 });

  const opened = new Promise(resolve => extension.browser.once('targetcreated', target => resolve(target)));
  await session.click('Open in its own window');
  const target = await opened;
  assert.match(target.url(), new RegExp(`sidepanel\\.html\\?thread=${thread.id}$`));
  const popout = await target.page();
  await popout.waitForFunction(() => document.body.innerText.includes('E2E scenario finished'), { polling: 300 });
  await popout.close();
  await session.close();
});

test('a chat that names a workspace works in it, and the agent is told its context', async () => {
  mock.start('ws-task');
  const session = await openSession(extension, mock);
  await session.send('Run the scripted scenario ws-task. It is for Tech Ember Fest.');
  await session.waitForEnd();

  const thread = (await readThreads(session.panel)).find(t => t.title.includes('ws-task'));
  assert.equal(thread.workspaceId, 'tech-ember-fest');
  assert.match(await session.panelText(), /Working in Tech Ember Fest/);
  assert.ok(
    mock.run.requests.some(text => text.includes('[Workspace: Tech Ember Fest]')),
    'the agent sees the workspace',
  );

  // The chip moves it; the agent then sees no workspace
  await session.panel.select('select:has(option[value="tech-ember-fest"])', '');
  await waitForThread(session.panel, 'ws-task', t => !t.workspaceId);
  await session.close();
});
