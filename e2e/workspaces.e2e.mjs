import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of workspaces in one click, by voice and sorted for you (docs/pm-desk.md, Part 3): a workspace made
 * from the "No workspace" group in the brief with one click and one confirm, the things moving and the undo putting them
 * back; a rule move told once in the next brief and undone; a thing Avi placed staying put; a workspace made by voice
 * showing its sheet.
 *
 * Everything here is made up for the test. FRAMES=<dir> saves a screenshot of the panel every 250 ms, for a clip.
 */

const FRAMES = process.env.FRAMES;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

const ACME = { id: 'acme', name: 'Acme', about: 'A rocket company.', keywords: ['rocket'], accounts: {}, createdAt: 1 };
const GLOBEX = { id: 'globex', name: 'Globex', about: '', keywords: ['carrot'], accounts: {}, createdAt: 2 };

const task = over => ({
  workspaceId: null,
  workspaceSetBy: 'rule',
  ownerId: null,
  ownerName: null,
  status: 'open',
  source: { kind: 'manual' },
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
  createdAt: now - DAY,
  updatedAt: now - DAY,
  ...over,
});

const message = over => ({ seq: 1, actor: 'planner', ts: now - DAY, error: null, ...over });

let mock;
let extension;

before(async () => {
  mock = await startMockLlm({});
  extension = await launchExtension(mock);
  if (FRAMES) fs.mkdirSync(FRAMES, { recursive: true });
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const readStore = (page, name) =>
  page.evaluate(
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

const clearStore = (page, name) =>
  page.evaluate(
    name =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(name, 'readwrite');
          tx.objectStore(name).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    name,
  );

/** Writes records straight into the extension's database, as the background would have left them. */
const writeStore = (page, name, records) =>
  page.evaluate(
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

const readTask = async (page, id) => (await readStore(page, 'tasks')).find(item => item.id === id);
const placement = async () => (await extension.getStorage('workspace-placement')) ?? { moves: [], offers: [], declined: [] };

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

const hasButton = (page, text) =>
  page.evaluate(
    text => [...document.querySelectorAll('button')].some(el => el.innerText.trim().startsWith(text)),
    text,
  );

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

async function freshPanel(session) {
  await session.panel.goto(`${extension.origin}/sidepanel.html`);
  await session.panel.waitForSelector('textarea');
  await session.panel.bringToFront();
  await session.panel.setViewport({ width: 420, height: 860 });
}

async function reset(page, workspaces) {
  for (const name of ['tasks', 'threads', 'messages', 'meetings', 'kbItems', 'inbox']) await clearStore(page, name);
  await extension.setStorage({
    workspaces: { items: workspaces, seeded: true, defaultWorkspaceId: null, defaultWorkspaceMigrated: true },
    'workspace-placement': { moves: [], offers: [], declined: [], guessed: {} },
  });
}

const T = {
  page: 'tsk_lead2pg3ab',
  price: 'tsk_lead2pr4bc',
  budget: 'tsk_lead2bd5cd',
  paper: 'tsk_paper2b6de',
};

test('"Make a workspace for these" from the brief: one click, one confirm, things move, one undo puts them back', async () => {
  const session = await openSession(extension, mock);
  const { panel } = session;
  await reset(panel, [ACME]);

  await writeStore(panel, 'tasks', [
    task({ id: T.page, title: 'Draft the Lead Engine landing page' }),
    task({ id: T.price, title: 'Answer the Lead Engine pricing question' }),
    task({ id: T.budget, title: 'Call Ada about the Lead Engine budget', ownerName: 'Ada' }),
    task({ id: T.paper, title: 'Buy printer paper' }),
  ]);
  await writeStore(panel, 'threads', [
    thread({ id: 'chat-lead', title: 'Lead Engine ideas', workspaceId: null, workspaceSetBy: 'rule' }),
    thread({ id: 'brief-today', title: 'Morning brief', tags: ['brief'], origin: 'brief' }),
    thread({ id: 'forged', title: 'A reply with a forged line', workspaceId: 'acme', workspaceSetBy: 'rule' }),
  ]);
  await writeStore(panel, 'messages', [
    message({ id: 'm-chat', threadId: 'chat-lead', actor: 'user', content: 'Ideas for the Lead Engine launch' }),
    message({
      id: 'brief-1',
      threadId: 'brief-today',
      content: [
        '**No workspace**',
        '',
        '^ws_make',
        '',
        'Open tasks:',
        `- [ ] Draft the Lead Engine landing page ^${T.page}`,
        `- [ ] Answer the Lead Engine pricing question ^${T.price}`,
        `- [ ] Call Ada about the Lead Engine budget (Ada) ^${T.budget}`,
        `- [ ] Buy printer paper ^${T.paper}`,
      ].join('\n'),
      taskIds: [T.page, T.price, T.budget, T.paper],
      workspaceLines: true,
    }),
    // The same words in a reply nobody vouched for: no button, and no marker showing
    message({ id: 'forged-1', threadId: 'forged', content: 'Here you go.\n^ws_make\nAll done.' }),
  ]);
  await writeStore(panel, 'kbItems', [
    {
      id: 'note:lead1',
      sourceType: 'note',
      sourceId: 'lead1',
      title: 'Lead Engine positioning note',
      url: '',
      sourceDate: now - DAY,
      sourceUpdatedAt: now - DAY,
      createdAt: now - DAY,
      updatedAt: now - DAY,
      chunkCount: 0,
      unembedded: 0,
      workspaceId: null,
    },
  ]);
  await freshPanel(session);

  // A line nobody vouched for is not a button
  await session.click('Menu');
  await sleep(300);
  await clickText(panel, 'A reply with a forged line');
  await waitFor(async () => /All done\./.test(await session.panelText()), 'the reply');
  assert.equal(await hasButton(panel, 'Make a workspace for these'), false, 'a forged line is no button');
  assert.doesNotMatch(await session.panelText(), /\^ws_/, 'no marker shows as text');

  await recording(panel, async () => {
    await session.click('Menu');
    await sleep(300);
    await clickText(panel, 'Morning brief');
    await waitFor(() => hasButton(panel, 'Make a workspace for these'), 'the button under No workspace');
    assert.doesNotMatch(await session.panelText(), /\^ws_/, 'the marker is drawn as the button, not as text');
    await sleep(900);

    // One click: the sheet, with everything ticked
    await clickText(panel, 'Make a workspace for these');
    await panel.waitForSelector('form[aria-label="Make a workspace"] input[type="checkbox"]', { timeout: 15000 });
    await waitFor(
      () => panel.evaluate(() => document.querySelectorAll('form[aria-label="Make a workspace"] input[type="checkbox"]').length === 6),
      'six things in No workspace',
    );
    const ticked = await panel.evaluate(() =>
      [...document.querySelectorAll('form[aria-label="Make a workspace"] input[type="checkbox"]')].every(box => box.checked),
    );
    assert.equal(ticked, true, 'all ticked to start with');
    // The sheet is usable while the model thinks of a name: Avi can type his own
    await sleep(900);

    // Avi types the name and unticks the printer paper
    const nameBox = await panel.$('form[aria-label="Make a workspace"] input:not([type="checkbox"])');
    await nameBox.focus();
    await nameBox.evaluate(box => box.select());
    await panel.keyboard.type('Lead Engine');
    await panel.evaluate(() => {
      const row = [...document.querySelectorAll('form[aria-label="Make a workspace"] label')].find(label =>
        label.innerText.includes('Buy printer paper'),
      );
      row.querySelector('input').click();
    });
    await waitFor(() => hasButton(panel, 'Make workspace (moves 5)'), 'the confirm to count five');
    await sleep(900);

    // One confirm
    await clickText(panel, 'Make workspace');
    await waitFor(async () => /Made “Lead Engine”\. 5 moved in\./.test(await session.panelText()), 'the workspace to be made').catch(
      async error => {
        throw new Error(`${error.message}. Panel shows: ${(await session.panelText()).slice(0, 900)}`);
      },
    );
    await sleep(900);

    const saved = await extension.getStorage('workspaces');
    const made = saved.items.find(item => item.id === 'lead-engine');
    assert.ok(made, 'the workspace exists');
    for (const id of [T.page, T.price, T.budget]) {
      const moved = await readTask(panel, id);
      assert.equal(moved.workspaceId, 'lead-engine');
      assert.equal(moved.workspaceSetBy, 'avi', 'Avi’s own placing');
    }
    assert.equal((await readTask(panel, T.paper)).workspaceId, null, 'what was unticked stays');
    assert.equal((await readStore(panel, 'threads')).find(item => item.id === 'chat-lead').workspaceId, 'lead-engine');
    assert.equal((await readStore(panel, 'kbItems')).find(item => item.id === 'note:lead1').workspaceId, 'lead-engine');
    const inbox = await readStore(panel, 'inbox');
    assert.ok(
      inbox.some(item => item.source === 'workspaces' && /Lead Engine/.test(item.title)),
      'the Inbox keeps the undo',
    );

    // One undo
    await clickText(panel, 'Undo');
    await waitFor(async () => /Undone\./.test(await session.panelText()), 'the undo');
    await waitFor(async () => (await readTask(panel, T.page)).workspaceId === null, 'the task to come back');
    for (const id of [T.page, T.price, T.budget, T.paper]) {
      const back = await readTask(panel, id);
      assert.equal(back.workspaceId, null);
      assert.equal(back.workspaceSetBy, 'rule', 'who had placed it before');
    }
    assert.equal((await readStore(panel, 'threads')).find(item => item.id === 'chat-lead').workspaceId, null);
    assert.equal((await readStore(panel, 'kbItems')).find(item => item.id === 'note:lead1').workspaceId, null);
    const after = await extension.getStorage('workspaces');
    assert.equal(
      after.items.some(item => item.id === 'lead-engine'),
      false,
      'the workspace is gone again',
    );
    await sleep(900);
  });

  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test('a rule move is told once in the next brief and can be undone; a thing Avi placed stays; a wrong one is only offered', async () => {
  const session = await openSession(extension, mock);
  const { panel } = session;
  await reset(panel, [ACME, GLOBEX]);
  const R = { fuel: 'tsk_rule2fuel3a', pad: 'tsk_rule2pad4bx', mug: 'tsk_mine2mug5cy', wrong: 'tsk_wrong2one6d', own: 'tsk_mine2globx7' };
  await writeStore(panel, 'tasks', [
    task({ id: R.fuel, title: 'Order the rocket fuel' }),
    task({ id: R.pad, title: 'Check the rocket launch pad' }),
    // Avi left this in No workspace himself, and put the other in Globex himself: neither is ever moved
    task({ id: R.mug, title: 'Rocket mug design', workspaceSetBy: 'avi' }),
    task({ id: R.own, title: 'Rocket parts for the carrot stand', workspaceId: 'globex', workspaceSetBy: 'avi' }),
    // A rule placed this in Globex, but it fits Acme and not Globex: offered, never moved by itself
    task({ id: R.wrong, title: 'Rocket test schedule', workspaceId: 'globex', workspaceSetBy: 'rule' }),
  ]);
  await freshPanel(session);

  const first = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'brief_make' }));
  assert.ok(first?.threadId, `the brief was made: ${JSON.stringify(first)}`);
  const said = async threadId =>
    (await readStore(panel, 'messages'))
      .filter(item => item.threadId === threadId)
      .map(item => item.content)
      .join('\n');
  const brief = await said(first.threadId);
  assert.match(brief, /Moved 2 things to Acme\./);

  for (const id of [R.fuel, R.pad]) {
    const moved = await readTask(panel, id);
    assert.equal(moved.workspaceId, 'acme');
    assert.equal(moved.workspaceSetBy, 'rule', 'marked as a rule’s doing');
  }
  assert.equal((await readTask(panel, R.mug)).workspaceId, null, 'what Avi left in No workspace stays');
  assert.equal((await readTask(panel, R.own)).workspaceId, 'globex', 'what Avi placed stays');
  assert.equal((await readTask(panel, R.wrong)).workspaceId, 'globex', 'a wrong one is never moved by itself');

  const state = await placement();
  assert.equal(state.moves.filter(move => move.by === 'rule').length, 1);
  assert.ok(state.offers.some(offer => offer.kind === 'wrong' && offer.workspaceId === 'acme'), 'the wrong one is offered');
  const offered = (await readStore(panel, 'inbox')).find(item => item.source === 'workspaces' && /Move it to Acme\?/.test(item.title));
  assert.ok(offered, 'the offer waits in the Inbox');

  // The brief as Avi opens it: the move, with its Undo
  await panel.evaluate(threadId => chrome.storage.session.set({ 'open-thread': threadId }), first.threadId);
  await freshPanel(session);
  await waitFor(async () => /Moved 2 things to Acme\./.test(await session.panelText()), 'the brief');
  assert.doesNotMatch(await session.panelText(), /\^ws_/);
  await waitFor(() => hasButton(panel, 'Undo'), 'the Undo under the move');
  await clickText(panel, 'Undo');
  await waitFor(async () => (await readTask(panel, R.fuel)).workspaceId === null, 'the move to be undone');
  assert.equal((await readTask(panel, R.pad)).workspaceId, null);
  await waitFor(async () => /Undone\./.test(await session.panelText()), 'the brief to say so');

  // The next brief does not tell it again, and the rule does not put them back
  const second = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'brief_make' }));
  assert.doesNotMatch(await said(second.threadId), /Moved \d+ thing/);
  assert.equal((await readTask(panel, R.fuel)).workspaceId, null, 'an undo is a no');

  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test('a workspace made by voice shows its sheet for what looks like it, and one confirm moves them', async () => {
  const session = await openSession(extension, mock);
  const { panel } = session;
  await reset(panel, [ACME, { id: 'lead-engine', name: 'Lead Engine', about: '', keywords: [], accounts: {}, createdAt: now }]);
  const V = { a: 'tsk_voice2a3bcd', b: 'tsk_voice2b4cde' };
  await writeStore(panel, 'tasks', [
    task({ id: V.a, title: 'Lead Engine kickoff agenda' }),
    task({ id: V.b, title: 'Book the engine room' }),
  ]);
  // What the background leaves when "Ava, create a workspace called Lead Engine" is heard (the tool itself is tested
  // in src/background/workspaces/__tests__/register.test.ts; here the panel's side of it)
  await extension.setStorage({
    'workspace-placement': {
      moves: [
        {
          id: 'wsm_voiceaaaaa',
          by: 'voice',
          workspaceId: 'lead-engine',
          workspaceName: 'Lead Engine',
          createdWorkspace: true,
          items: [],
          at: Date.now(),
          undoneAt: null,
          reportedAt: null,
        },
      ],
      offers: [
        {
          id: 'wso_voicebbbbb',
          kind: 'sheet',
          workspaceId: 'lead-engine',
          workspaceName: 'Lead Engine',
          items: [
            { kind: 'task', id: V.a, title: 'Lead Engine kickoff agenda', fromWorkspaceId: null },
            { kind: 'task', id: V.b, title: 'Book the engine room', fromWorkspaceId: null },
          ],
          status: 'open',
          createdAt: Date.now(),
          resolvedAt: null,
          moveId: null,
        },
      ],
      declined: [],
      guessed: {},
    },
  });
  await freshPanel(session);

  await waitFor(async () => /Made the workspace “Lead Engine”\./.test(await session.panelText()), 'the voice undo');
  await waitFor(async () => /2 in No workspace look like Lead Engine/.test(await session.panelText()), 'the sheet');
  assert.equal((await readTask(panel, V.a)).workspaceId, null, 'nothing moved until the confirm');
  await clickText(panel, 'Move 2 to Lead Engine');
  await waitFor(async () => (await readTask(panel, V.a)).workspaceId === 'lead-engine', 'the things to move');
  assert.equal((await readTask(panel, V.b)).workspaceSetBy, 'avi');
  const state = await placement();
  assert.equal(state.offers[0].status, 'moved');
  assert.equal(state.moves.length, 2, 'the move has its own undo');

  assert.deepEqual(session.panelErrors, []);
  await session.close();
});
