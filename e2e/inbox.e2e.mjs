import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession } from './harness.mjs';

/**
 * End-to-end tests of the Inbox: items land and show with the right badge count, a workflow approval
 * is answered inline end to end, and a WhatsApp-Web-like tab posts an item through the tab watcher.
 * Data for the first two is written straight into the extension's IndexedDB (the same way
 * e2e/graph.e2e.mjs and e2e/kb.e2e.mjs seed), faster and more deterministic than driving a whole
 * workflow run or waiting for the real tab-watcher cron to fire.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const WHATSAPP_FIXTURE = fs.readFileSync(path.join(here, 'fixtures/inbox/whatsapp.html'), 'utf8');

let mock;
let extension;

before(async () => {
  mock = await startMockLlm({});
  extension = await launchExtension(mock);
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

/** Reads a whole object store of the extension's database, through an extension page. */
function readStore(page, name) {
  return page.evaluate(
    name =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction(name).objectStore(name).getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        };
      }),
    name,
  );
}

/** Writes records straight into the extension's database, as the background would leave them. */
function writeStore(page, name, records) {
  return page.evaluate(
    (name, records) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(name, 'readwrite');
          for (const record of records) tx.objectStore(name).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    name,
    records,
  );
}

const inboxItem = over => ({
  links: [],
  priority: 'normal',
  status: 'unread',
  snoozeUntil: null,
  workspaceId: null,
  agentId: null,
  runId: null,
  approval: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...over,
  id: `${over.source}|${over.externalId}`,
});

/** Opens the Inbox place from the drawer's top list. */
async function openInbox(session) {
  await session.click('Menu');
  await session.click('Inbox');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Inbox'), { polling: 300 });
}

function badgeText(session) {
  return session.panel.evaluate(() => chrome.action.getBadgeText({}));
}

test('seeded items show in the Inbox with the right badge, and the filters narrow the list', async () => {
  const session = await openSession(extension, mock);
  await writeStore(session.panel, 'inbox', [
    inboxItem({ source: 'gmail-web', externalId: 'm1', kind: 'message', title: 'Alex Rivera', body: 'Budget for Q4' }),
    inboxItem({
      source: 'workflow:w1',
      externalId: 'a1',
      kind: 'approval',
      title: 'Morning brief wants to: send the digest',
      body: 'Waits for your click.',
      priority: 'high',
      runId: 'r1',
      approval: { requestId: 'workflow-step:r1:send', action: 'workflow_step_answer' },
    }),
    inboxItem({
      source: 'system',
      externalId: 'done1',
      kind: 'result',
      title: 'Backup finished',
      body: 'ok',
      status: 'done',
    }),
  ]);

  await openInbox(session);
  await session.panel.waitForFunction(() => document.body.innerText.includes('Alex Rivera'), { polling: 300 });
  const text = await session.panelText();
  assert.match(text, /Alex Rivera/);
  assert.match(text, /send the digest/);
  assert.match(text, /Backup finished/);

  // Rows seeded straight into IndexedDB never pass through the background's own Dexie instance (and
  // so never trigger its "creating"/"updating" hooks, which is how the badge count is kept live) -
  // opening one item is a real write through the real command, and the badge then reflects every
  // unread row in the table, seeded or not: two unread (the message and the approval) minus the one
  // just opened leaves one
  await session.click('Alex Rivera');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Back'), { polling: 300 });
  await session.panel.waitForFunction(() => chrome.action.getBadgeText({}).then(badge => badge === '1'), {
    polling: 300,
    timeout: 10000,
  });
  await session.click('Back');

  await session.click('Approvals');
  await session.panel.waitForFunction(() => !document.body.innerText.includes('Alex Rivera'), { polling: 300 });
  const approvalsOnly = await session.panelText();
  assert.match(approvalsOnly, /send the digest/);
  assert.doesNotMatch(approvalsOnly, /Alex Rivera/);
  assert.doesNotMatch(approvalsOnly, /Backup finished/);

  await session.click('All');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Backup finished'), { polling: 300 });

  assert.deepEqual(session.panelErrors, [], 'no uncaught page errors');
  await session.close();
});

test('approving a workflow approval inline answers the run and settles the Inbox item', async () => {
  const session = await openSession(extension, mock);
  const now = Date.now();
  await writeStore(session.panel, 'workflows', [
    {
      id: 'wf-approve-1',
      name: 'Send the weekly digest',
      description: '',
      workspaceId: null,
      agentId: null,
      spec: null,
      version: 1,
      status: 'active',
      failuresInRow: 0,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await writeStore(session.panel, 'runs', [
    {
      id: 'run-approve-1',
      kind: 'workflow',
      workflowId: 'wf-approve-1',
      agentId: null,
      workspaceId: null,
      trigger: { type: 'manual', detail: 'seed' },
      status: 'waiting_user',
      tainted: false,
      startedAt: now,
      endedAt: null,
      leaseUntil: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: null,
    },
  ]);
  await writeStore(session.panel, 'runSteps', [
    {
      id: 'step-approve-1',
      runId: 'run-approve-1',
      nodeId: 'send',
      index: 0,
      status: 'waiting_user',
      sideEffect: true,
      attempts: 0,
      startedAt: now,
      endedAt: null,
      input: null,
      output: null,
      error: null,
      approval: 'pending',
    },
  ]);
  await writeStore(session.panel, 'inbox', [
    inboxItem({
      source: 'workflow:wf-approve-1',
      externalId: 'run-approve-1:send:approval',
      kind: 'approval',
      title: '"Send the weekly digest" wants to: Send the email',
      body: 'This step acts for you, so it waits for your click.',
      priority: 'high',
      runId: 'run-approve-1',
      approval: { requestId: 'workflow-step:run-approve-1:send', action: 'workflow_step_answer' },
    }),
  ]);

  await openInbox(session);
  await session.panel.waitForFunction(() => document.body.innerText.includes('Send the email'), { polling: 300 });
  await session.click('Approve');

  // Poll the database directly rather than the panel's re-render: this tells apart "the backend
  // answered it" from "the panel's live query redrew in time", and prints what actually happened
  // (including any error banner) if the backend side never completed. The Inbox item settles last
  // in workflowService.answer() (after the step, then the run), so waiting for its status is the
  // signal that the whole chain - not just its first step - has committed. Earlier tests' rows share
  // this same database, so every table is searched by id rather than assumed to hold just one row.
  const itemId = 'workflow:wf-approve-1|run-approve-1:send:approval';
  const deadline = Date.now() + 10000;
  let item;
  do {
    item = (await readStore(session.panel, 'inbox')).find(row => row.id === itemId);
    if (item?.status === 'done') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  if (item?.status !== 'done') {
    throw new Error(`The approval was never settled. Panel shows: ${(await session.panelText()).slice(0, 600)}`);
  }

  const step = (await readStore(session.panel, 'runSteps')).find(row => row.id === 'step-approve-1');
  assert.equal(step.approval, 'approved');
  const run = (await readStore(session.panel, 'runs')).find(row => row.id === 'run-approve-1');
  assert.notEqual(run.status, 'waiting_user');
  assert.equal(item.status, 'done');

  assert.deepEqual(session.panelErrors, [], 'no uncaught page errors');
  await session.close();
});

test('a WhatsApp-Web-like tab posts its unread conversations through the tab watcher', async () => {
  const whatsapp = await extension.browser.newPage();
  await whatsapp.setRequestInterception(true);
  whatsapp.on('request', request =>
    request.url().startsWith('https://web.whatsapp.com/')
      ? request.respond({ status: 200, contentType: 'text/html', body: WHATSAPP_FIXTURE })
      : request.continue(),
  );
  await whatsapp.goto('https://web.whatsapp.com/');

  const session = await openSession(extension, mock);
  // Settings › Meetings & brief › Inbox, on the full-page Settings
  const settings = await extension.openSettings('#meetings/inbox');
  await settings.waitForFunction(() => document.body.innerText.includes('Speak up when something needs me'), {
    polling: 300,
    timeout: 10000,
  });
  await extension.clickOn(settings, 'WhatsApp Web');
  await settings.waitForFunction(() => document.body.innerText.includes('Check now'), { polling: 300 });
  await extension.clickOn(settings, 'Check now');
  await settings.waitForFunction(() => /Found \d+ new item/.test(document.body.innerText), {
    polling: 300,
    timeout: 15000,
  });
  assert.match(await settings.evaluate(() => document.body.innerText), /Found 2 new item/);
  await settings.close();

  const items = await readStore(session.panel, 'inbox');
  const fromWhatsapp = items.filter(item => item.source === 'whatsapp-web');
  assert.equal(fromWhatsapp.length, 2, 'only the two unread conversations are read, never the read one');
  assert.ok(fromWhatsapp.some(item => item.title === 'Priya Patel'));
  assert.ok(fromWhatsapp.some(item => item.title === 'Dev Team'));
  assert.ok(!fromWhatsapp.some(item => item.title === 'Mom'), 'the already-read conversation is skipped');

  await openInbox(session);
  await session.panel.waitForFunction(() => document.body.innerText.includes('Priya Patel'), { polling: 300 });
  assert.match(await session.panelText(), /Dev Team/);

  await session.close();
  await whatsapp.close();
});
