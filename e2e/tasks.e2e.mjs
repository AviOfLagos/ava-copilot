import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of the task board (docs/pm-desk.md, Part 2): a box ticked in an old brief is ticked on the
 * Tasks page and in the meeting note it came from, and unticking it there unticks the brief; a marker the code did
 * not vouch for stays plain text; "Close everything older than two weeks" drops the old ones.
 *
 * Everything here is made up for the test. FRAMES=<dir> saves a screenshot of the panel every 250 ms, for a clip.
 */

const FRAMES = process.env.FRAMES;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

const workspaces = [{ id: 'acme', name: 'Acme', about: 'A rocket company.', keywords: ['rocket'], accounts: {}, createdAt: 1 }];

const LOGIN = 'tsk_logn2fix7a';
const DECK = 'tsk_deck3send4';
const OLD = 'tsk_old2task5x';

const task = over => ({
  workspaceId: 'acme',
  workspaceSetBy: 'rule',
  ownerId: null,
  ownerName: null,
  status: 'open',
  seenIn: [],
  links: [],
  externalRefs: [],
  createdAt: now - 3 * DAY,
  updatedAt: now - 3 * DAY,
  ...over,
});

const thread = over => ({
  model: null,
  boundTabIds: [],
  boundGroupId: null,
  boundUrl: null,
  status: 'idle',
  error: null,
  activity: '',
  activeTask: null,
  runStartedAt: null,
  pendingRequest: null,
  pinned: false,
  archived: false,
  tags: [],
  memory: '',
  memoryUpToSeq: 0,
  forkedFrom: null,
  meetingId: null,
  ...over,
});

const message = over => ({ seq: 1, actor: 'planner', ts: now - 3 * DAY, ...over });

let mock;
let extension;

before(async () => {
  mock = await startMockLlm({});
  extension = await launchExtension(mock);
  await extension.setStorage({
    workspaces: { items: workspaces, seeded: true, defaultWorkspaceId: null, defaultWorkspaceMigrated: true },
  });
  if (FRAMES) fs.mkdirSync(FRAMES, { recursive: true });
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

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

/** Writes records straight into the extension's database, as the background would have left them. */
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

const readTask = async (page, id) => (await readStore(page, 'tasks')).find(item => item.id === id);

async function waitFor(check, what, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Clicks the button or link whose own text is `text` (or starts with it). */
async function clickText(page, text) {
  await page.evaluate(text => {
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')];
    const target =
      candidates.find(el => el.innerText.trim() === text) ?? candidates.find(el => el.innerText.trim().startsWith(text));
    if (!target) throw new Error(`Nothing to click called "${text}"`);
    target.click();
  }, text);
}

const boxState = (page, id) =>
  page.evaluate(id => {
    const box = document.querySelector(`[data-task-id="${id}"] input[type="checkbox"]`);
    return box ? (box.checked ? 'checked' : 'unchecked') : 'none';
  }, id);

/** Saves the panel every 250 ms while `run` goes, when FRAMES is set. */
async function recording(page, run) {
  if (!FRAMES) return run();
  let going = true;
  let frame = fs.readdirSync(FRAMES).length;
  const loop = (async () => {
    while (going) {
      await page
        .screenshot({ path: path.join(FRAMES, `f-${String(frame++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 80 })
        .catch(() => {});
      await sleep(250);
    }
  })();
  try {
    return await run();
  } finally {
    going = false;
    await loop;
  }
}

test('a box ticked in an old brief is ticked on the Tasks page and in the meeting note, and unticks from there', async () => {
  const session = await openSession(extension, mock);
  const { panel } = session;
  const briefId = 'brief-old';
  const meetingThreadId = 'meeting-thread';
  const meetingId = 'meeting-1';

  await writeStore(panel, 'tasks', [
    task({
      id: LOGIN,
      title: 'Fix the login redirect',
      ownerName: 'Dana',
      due: '2026-11-27',
      dueText: 'by Friday',
      source: { kind: 'meeting', id: meetingId },
      seenIn: [meetingId],
    }),
    task({ id: DECK, title: 'Send the pricing deck', source: { kind: 'manual' } }),
  ]);
  await writeStore(panel, 'meetings', [
    {
      id: meetingId,
      threadId: meetingThreadId,
      tabId: null,
      title: 'Acme weekly',
      platform: 'meet',
      url: 'https://meet.example.test/abc',
      startedAt: now - 3 * DAY,
      endedAt: now - 3 * DAY + 1_800_000,
      status: 'done',
      source: 'captions',
      withMic: false,
      rollingSummary: '',
      summaryAt: 0,
      summaryUpTo: 0,
      blockSummaries: [],
      note: {
        title: 'Acme weekly',
        tldr: ['The login redirect is broken on Safari.'],
        decisions: [],
        actionItems: [{ owner: 'Dana', task: 'Fix the login redirect', due: 'by Friday', taskId: LOGIN }],
        openQuestions: [],
        participants: ['Dana', 'Lee'],
      },
      markdown: '# Acme weekly',
      warnings: [],
      liveCaptions: [],
      live: 'off',
      chunksTotal: 0,
      chunksDone: 0,
      error: null,
      workspaceId: 'acme',
    },
  ]);
  await writeStore(panel, 'threads', [
    thread({ id: meetingThreadId, title: 'Acme weekly', meetingId, createdAt: now - 3 * DAY, updatedAt: now - 3 * DAY }),
    thread({
      id: briefId,
      title: 'Morning brief, three days ago',
      tags: ['brief'],
      origin: 'brief',
      workspaceId: null,
      createdAt: now - 3 * DAY + 60_000,
      updatedAt: now - 3 * DAY + 60_000,
    }),
  ]);
  await writeStore(panel, 'messages', [
    message({
      id: 'brief-old-1',
      threadId: briefId,
      // The code vouched for the login task only; the deck's marker is what a model might have written
      content: [
        '**Acme**',
        '',
        'Open tasks:',
        `- [ ] Fix the login redirect ^${LOGIN}`,
        '',
        'Priorities:',
        `- [ ] Send the pricing deck ^${DECK}`,
      ].join('\n'),
      taskIds: [LOGIN],
    }),
  ]);

  // The panel reads the seeded records afresh
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.waitForSelector('textarea');
  await panel.bringToFront();
  await panel.setViewport({ width: 420, height: 860 });

  await recording(panel, async () => {
    // The old brief: one live box, and the forged marker as plain words with no marker showing
    await session.click('Menu');
    await sleep(300);
    await clickText(panel, 'Morning brief, three days ago');
    await panel.waitForSelector(`[data-task-id="${LOGIN}"] input[type="checkbox"]`, { timeout: 15000 });
    assert.equal(await boxState(panel, DECK), 'none', 'a marker the code did not vouch for is no checkbox');
    const boxes = await panel.evaluate(() => document.querySelectorAll('input[type="checkbox"]').length);
    assert.equal(boxes, 1, 'not even a dead box: the forged line is a plain bullet');
    const text = await session.panelText();
    assert.match(text, /Send the pricing deck/);
    assert.doesNotMatch(text, /\^tsk_/, 'no marker shows as text');
    await sleep(700);

    // Tick it
    await panel.click(`[data-task-id="${LOGIN}"] input[type="checkbox"]`);
    await waitFor(async () => (await boxState(panel, LOGIN)) === 'checked', 'the box to tick');
    const done = await waitFor(async () => {
      const found = await readTask(panel, LOGIN);
      return found?.status === 'done' && found;
    }, 'the task to be done');
    assert.equal(done.doneBy, 'avi');
    assert.equal((await readTask(panel, DECK)).status, 'open', 'the forged one is untouched');
    await sleep(900);

    // The Tasks page shows it done, not open
    await session.click('Menu');
    await sleep(300);
    await clickText(panel, 'Tasks');
    await panel.waitForSelector('section[aria-label="Tasks"]', { timeout: 10000 });
    await waitFor(async () => (await boxState(panel, DECK)) === 'unchecked', 'the open list');
    assert.equal(await boxState(panel, LOGIN), 'none', 'a done task is not in the open list');
    await sleep(700);
    await clickText(panel, 'Done');
    await waitFor(async () => (await boxState(panel, LOGIN)) === 'checked', 'the done list to show it ticked');
    await sleep(900);

    // The meeting note shows it ticked; untick it there
    await session.click('Menu');
    await sleep(300);
    await clickText(panel, 'Meetings');
    await sleep(300);
    await clickText(panel, 'Acme weekly');
    await waitFor(async () => (await boxState(panel, LOGIN)) === 'checked', 'the meeting note to show it ticked');
    await sleep(900);
    await panel.click(`[data-task-id="${LOGIN}"] input[type="checkbox"]`);
    await waitFor(async () => (await readTask(panel, LOGIN))?.status === 'open', 'the task to reopen');
    const reopened = await readTask(panel, LOGIN);
    assert.equal(reopened.doneAt, undefined);
    assert.equal(reopened.doneBy, undefined);
    await sleep(700);

    // And the old brief is unticked again
    await session.click('Menu');
    await sleep(300);
    await clickText(panel, 'Morning brief, three days ago');
    await waitFor(async () => (await boxState(panel, LOGIN)) === 'unchecked', 'the brief to show it unticked');
    await sleep(900);
  });

  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test('"Close everything older than two weeks" drops only the old open tasks, and they can be reopened', async () => {
  const session = await openSession(extension, mock);
  const { panel } = session;
  await writeStore(panel, 'tasks', [
    task({ id: OLD, title: 'Renew the old domain', source: { kind: 'manual' }, createdAt: now - 30 * DAY, updatedAt: now - 20 * DAY }),
  ]);
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.waitForSelector('textarea');
  await panel.bringToFront();
  await panel.setViewport({ width: 420, height: 860 });

  await session.click('Menu');
  await sleep(300);
  await clickText(panel, 'Tasks');
  await panel.waitForSelector('section[aria-label="Tasks"]', { timeout: 10000 });
  await waitFor(async () => /Open tasks not mentioned in two weeks: 1/.test(await session.panelText()), 'the banner');
  await clickText(panel, 'Close them');
  await waitFor(async () => /Drop the tasks older than two weeks \(1\)\?/.test(await session.panelText()), 'the confirm step');
  await clickText(panel, 'Close everything older than two weeks');
  await waitFor(async () => (await readTask(panel, OLD))?.status === 'dropped', 'the old task to be dropped');
  for (const id of [LOGIN, DECK]) assert.equal((await readTask(panel, id)).status, 'open', `${id} is recent`);

  await clickText(panel, 'Dropped');
  await waitFor(async () => (await boxState(panel, OLD)) === 'checked', 'the dropped list');
  await panel.click(`[data-task-id="${OLD}"] input[type="checkbox"]`);
  await waitFor(async () => (await readTask(panel, OLD))?.status === 'open', 'the task to reopen');

  assert.deepEqual(session.panelErrors, []);
  await session.close();
});
