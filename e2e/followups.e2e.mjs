import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, sleep } from './harness.mjs';
import { nameKey } from '../src/storage/lib/people/names.ts';

/**
 * End-to-end tests of follow-ups (docs/pm-desk.md, Part 9): a call where two people give updates leaves a status on
 * each person's page and a "Mark done?" that only Avi's click answers; a task three working days quiet shows under
 * "Follow up today" in the brief with a draft naming the person and the task, "Asked" moves it two working days on,
 * and "Done" closes it on the Tasks page. Avi's own tasks never show there.
 *
 * Everything here is made up for the test, and nothing is sent anywhere. FRAMES=<dir> saves a screenshot of the
 * panel every 250 ms, for a clip.
 */

const FRAMES = process.env.FRAMES;
const DAY = 24 * 60 * 60 * 1000;

let mock;
let extension;
let panel;

before(async () => {
  mock = await startMockLlm({});
  extension = await launchExtension(mock);
  // E2E_DEBUG=1 prints the background's warnings
  if (process.env.E2E_DEBUG) {
    (await serviceWorker()).on('console', message => console.log('[sw]', message.text()));
  }
  if (FRAMES) fs.mkdirSync(FRAMES, { recursive: true });
  await extension.setStorage({
    'account-profile': { displayName: 'Avi Example' },
    'meeting-settings': {
      liveCaptions: false,
      includeMic: false,
      keepAudio: false,
      consentShown: true,
      chunkSeconds: 3,
      firstChunkSeconds: 2,
      overlapSeconds: 1,
      summaryEverySeconds: 4,
      silenceWarnSeconds: 30,
    },
  });
  panel = await extension.browser.newPage();
  panel.on('pageerror', error => panelErrors.push(String(error)));
  await freshPanel();
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const panelErrors = [];
const panelText = async () => (await panel.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');

async function freshPanel() {
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.waitForSelector('textarea');
  await panel.bringToFront();
  await panel.setViewport({ width: 420, height: 860 });
}

const request = message => panel.evaluate(message => chrome.runtime.sendMessage(message), message);

const readStore = name =>
  panel.evaluate(
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

const writeStore = (name, records) =>
  panel.evaluate(
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

const clearStore = name =>
  panel.evaluate(
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

const readTask = async id => (await readStore('tasks')).find(item => item.id === id);

async function waitFor(check, what, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}. Panel shows: ${(await panelText()).slice(0, 700)}`);
}

/** Clicks the button or link whose own text is `text` (or starts with it). */
async function clickText(text) {
  await panel.evaluate(text => {
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')];
    const target =
      candidates.find(el => el.innerText.trim() === text || el.getAttribute('aria-label') === text) ??
      candidates.find(el => el.innerText.trim().startsWith(text));
    if (!target) throw new Error(`Nothing to click called "${text}"`);
    target.click();
  }, text);
}

const clickTestId = async (id, within = '') => {
  const selector = `${within} [data-testid="${id}"]`.trim();
  await panel.waitForSelector(selector, { timeout: 15000 });
  // A DOM click: a mouse click waits for animation frames, which a tab in the background never gets
  await panel.$eval(selector, el => el.click());
};

/** Opens a page from the drawer menu. */
async function openPlace(label) {
  await clickText('Menu');
  await sleep(300);
  await clickText(label);
  await sleep(400);
}

/** Saves the panel every 250 ms while `run` goes, when FRAMES is set. */
async function recording(run) {
  if (!FRAMES) return run();
  // A screenshot waits for a frame, which only the tab in front gets
  await panel.bringToFront();
  let going = true;
  let frame = fs.readdirSync(FRAMES).length;
  const loop = (async () => {
    while (going) {
      // A shot taken while the panel reloads never comes back: give up on it after two seconds and take the next.
      // Each frame is written only when it arrives, so the numbering has no gaps.
      const shot = panel.screenshot({ type: 'jpeg', quality: 80 }).catch(() => null);
      const image = await Promise.race([shot, sleep(2000).then(() => null)]);
      if (image) fs.writeFileSync(path.join(FRAMES, `f-${String(frame++).padStart(5, '0')}.jpg`), image);
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

/** The extension's service worker, to move its clock. */
async function serviceWorker() {
  const target = extension.browser
    .targets()
    .find(item => item.type() === 'service_worker' && item.url().startsWith(extension.origin));
  if (!target) throw new Error('No service worker');
  return target.worker();
}

/**
 * Moves the background's clock to `at` (it keeps running from there): `Date.now()` and `new Date()` both read it.
 * A restarted service worker would be back on the real clock; nothing here restarts it.
 */
async function setBackgroundClock(at) {
  const worker = await serviceWorker();
  await worker.evaluate(offset => {
    const Real = globalThis.__realDate ?? Date;
    globalThis.__realDate = Real;
    class Shifted extends Real {
      constructor(...args) {
        if (args.length === 0) super(Real.now() + offset);
        else super(...args);
      }
      static now() {
        return Real.now() + offset;
      }
    }
    globalThis.Date = Shifted;
  }, at - Date.now());
}

/** A person on the People page, as the People store keeps one. */
async function addPerson(id, name) {
  const at = Date.now();
  await writeStore('people', [
    {
      id,
      name,
      aliases: [],
      handles: [],
      emails: [],
      phones: [],
      workspaceIds: [],
      seen: [{ source: 'meet', workspaceId: null, at: at - DAY }],
      nameKey: nameKey(name),
      aliasKeys: [],
      handleKeys: [],
      createdAt: at,
      updatedAt: at,
    },
  ]);
  return id;
}

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
  ...over,
});

/** The next Tuesday after today, 09:00 local: a working day with the weekend three working days behind it. */
function nextTuesday() {
  const day = new Date();
  day.setHours(9, 0, 0, 0);
  do day.setDate(day.getDate() + 1);
  while (day.getDay() !== 2);
  return day.getTime();
}

const startOfDay = at => new Date(at).setHours(0, 0, 0, 0);

test('a call where two people give updates leaves a status on each person page, and a "Mark done?" only Avi answers', async () => {
  const ada = await addPerson('per_adaobiaaaa', 'Ada Obi');
  const ben = await addPerson('per_bencoleaaa', 'Ben Cole');
  assert.ok(ada && ben, 'the two people were made');

  const DECK = 'tsk_deck2venue';
  await writeStore('tasks', [
    task({
      id: DECK,
      title: 'Send the deck to the venue',
      ownerId: ada,
      ownerName: 'Ada Obi',
      createdAt: Date.now() - 4 * DAY,
      updatedAt: Date.now() - 4 * DAY,
    }),
  ]);

  // The call's note, as the model would write it from what Ada and Ben said
  mock.meeting.note = {
    title: 'Launch sync notes',
    tldr: ['Ada sent the deck', 'Ben is on the login page'],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    participants: ['Ada Obi', 'Ben Cole'],
    personUpdates: [
      {
        name: 'Ada Obi',
        did: ['Sent the deck to the venue'],
        doing: ['Writing the launch post'],
        next: ['Book the photographer'],
        by: 'Thursday',
        blockers: [],
      },
      {
        name: 'Ben Cole',
        did: [],
        doing: ['Building the login page'],
        next: ['The signup form'],
        by: 'Friday',
        blockers: ['Waiting on the design files'],
      },
      // Somebody only talked about on the call gives no update, even if the model lists one
      { name: 'Chidi Eze', did: [], doing: ['The budget'], next: [], by: null, blockers: [] },
    ],
  };

  const web = await extension.browser.newPage();
  await web.goto(`http://127.0.0.1:${mock.port}/meeting.html?captions=1&speakers=Ada%20Obi,Ben%20Cole`);
  await web.bringToFront();
  await sleep(500);

  await panel.waitForSelector('button[aria-label="Take meeting notes"]');
  await panel.$eval('button[aria-label="Take meeting notes"]', el => el.click());
  await waitFor(async () => /from the meeting captions/.test(await panelText()), 'notes from the captions');
  // Both speakers talk at least once before the call ends
  await waitFor(
    async () => {
      const live = (await readStore('meetings')).sort((a, b) => b.startedAt - a.startedAt)[0];
      const speakers = new Set(
        (await readStore('segments')).filter(item => item.meetingId === live?.id).map(item => item.speaker),
      );
      return speakers.has('Ada Obi') && speakers.has('Ben Cole');
    },
    'both speakers in the transcript',
    30000,
  );
  await panel.evaluate(() =>
    [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Stop' || b.ariaLabel === 'Stop').click(),
  );
  await waitFor(async () => /Done ·/.test(await panelText()), 'the call to be done', 40000);

  const meeting = (await readStore('meetings')).sort((a, b) => b.startedAt - a.startedAt)[0];
  const updates = await waitFor(async () => {
    const all = (await readStore('personUpdates')).filter(item => item.source.id === meeting.id);
    return all.length >= 2 ? all : null;
  }, 'the updates to be kept');
  assert.equal(updates.length, 2, 'Chidi was only talked about');
  const byName = Object.fromEntries(updates.map(update => [update.name, update]));
  assert.equal(byName['Ada Obi'].personId, ada);
  assert.equal(byName['Ben Cole'].personId, ben);
  assert.deepEqual(byName['Ben Cole'].blockers, ['Waiting on the design files']);
  assert.ok(byName['Ada Obi'].by, 'Thursday became a date');
  assert.deepEqual(
    byName['Ada Obi'].offers.map(offer => offer.taskId),
    [DECK],
  );
  assert.equal((await readTask(DECK)).status, 'open', 'a "did" never closes a task by itself');

  // The meeting's chat: the note, its Updates section, and the "Mark done?" under it. The clip starts once it shows.
  const thread = (await readStore('threads')).find(item => item.meetingId === meeting.id);
  assert.ok(thread, 'the call has its chat');
  await panel.evaluate(threadId => chrome.storage.session.set({ 'open-thread': threadId }), thread.id);
  await freshPanel();
  await recording(async () => {
    await waitFor(async () => /Updates/.test(await panelText()), 'the Updates section');
    await panel.waitForSelector('[data-testid="markdone-card"]', { timeout: 15000 });
    await sleep(900);
    await clickTestId('markdone-yes');
    const done = await waitFor(async () => {
      const item = await readTask(DECK);
      return item.status === 'done' ? item : null;
    }, 'the task to be marked done');
    assert.equal(done.doneBy, 'avi', 'closed by Avi’s click');
    await sleep(900);

    // Each person's page shows what they are on
    await openPlace('People');
    await waitFor(async () => /Ada Obi/.test(await panelText()) && /Ben Cole/.test(await panelText()), 'People');
    await waitFor(
      async () =>
        /Writing the launch post/.test(await panelText()) && /Building the login page/.test(await panelText()),
      'each person’s status on the list',
    );
    await sleep(700);
    await clickText('Ada Obi');
    await panel.waitForSelector('[data-testid="person-status"]', { timeout: 10000 });
    const status = await panel.$eval('[data-testid="person-status"]', el => el.innerText.replace(/\s+/g, ' '));
    assert.match(status, /Writing the launch post/);
    assert.match(status, /Book the photographer/);
    await sleep(1200);
  });

  mock.meeting.note = null;
  await web.close();
  assert.deepEqual(panelErrors, []);
});

test('"Follow up today": a quiet task shows with a draft, Asked moves it two working days on, Done closes it', async () => {
  for (const name of ['tasks', 'threads', 'messages', 'inbox', 'personUpdates']) await clearStore(name);
  await extension.removeStorage(['followup-day']);
  const chidi = await addPerson('per_chidiezeaa', 'Chidi Eze');
  assert.ok(chidi);

  // Tuesday 09:00, with the task made the Wednesday before: Thu, Fri, Mon, Tue quiet, past the three working days
  const now = nextTuesday();
  await setBackgroundClock(now);
  const QUIET = 'tsk_quiet2chid';
  const MINE = 'tsk_mine2selfa';
  const MINE_NAMED = 'tsk_mine2named';
  const made = now - 6 * DAY;
  await writeStore('tasks', [
    task({
      id: QUIET,
      title: 'Send the venue contract',
      ownerId: chidi,
      ownerName: 'Chidi Eze',
      createdAt: made,
      updatedAt: made,
    }),
    // Avi's own tasks, just as quiet, never show
    task({ id: MINE, title: 'Pay the caterer', ownerName: 'me', createdAt: made, updatedAt: made }),
    task({ id: MINE_NAMED, title: 'Call the printer', ownerName: 'Avi', createdAt: made, updatedAt: made }),
  ]);

  const today = (await request({ type: 'followups_today' }))?.result;
  assert.deepEqual(
    today.map(item => item.taskId),
    [QUIET],
    'only the task someone else owns',
  );

  const brief = await request({ type: 'brief_make' });
  assert.ok(brief?.threadId, `the brief was made: ${JSON.stringify(brief)}`);
  const said = (await readStore('messages'))
    .filter(item => item.threadId === brief.threadId)
    .map(item => item.content)
    .join('\n');
  assert.match(said, /Follow up today/);
  assert.match(said, new RegExp(`\\^fu_${QUIET}`));
  assert.doesNotMatch(said, new RegExp(`\\^fu_(${MINE}|${MINE_NAMED})`));
  const inbox = (await readStore('inbox')).filter(item => item.source === 'followups');
  assert.equal(inbox.length, 1, 'one Inbox item for the day');

  await panel.evaluate(threadId => chrome.storage.session.set({ 'open-thread': threadId }), brief.threadId);
  await freshPanel();
  await recording(async () => {
    await waitFor(async () => /Follow up today/.test(await panelText()), 'the brief');
    assert.doesNotMatch(await panelText(), /\^fu_/);
    const card = `[data-testid="followup-card"][data-task="${QUIET}"]`;
    await panel.waitForSelector(`${card} [data-testid="followup-draft"]`, { timeout: 20000 });
    const draft = await waitFor(
      async () => (await panel.$eval(`${card} [data-testid="followup-draft"]`, el => el.value ?? el.innerText)) || null,
      'the draft',
    );
    assert.match(draft, /Chidi/, 'the draft names the person');
    assert.match(draft, /venue contract/i, 'and the task');
    assert.doesNotMatch(draft, /Avi Example|Pay the caterer|Call the printer/);
    await sleep(1500);

    await clickTestId('followup-asked', card);
    const asked = await waitFor(async () => {
      const item = await readTask(QUIET);
      return item.followUp?.askedAt ? item : null;
    }, 'Asked to be kept');
    // Two working days on from a Tuesday: Thursday, from its start
    assert.equal(asked.followUp.nextAt, startOfDay(now + 2 * DAY));
    assert.equal(asked.followUp.nextBy, 'asked');
    assert.equal(asked.status, 'open');
    await panel.waitForSelector(`${card} [data-testid="followup-state"]`, { timeout: 10000 });
    assert.match(await panel.$eval(`${card} [data-testid="followup-state"]`, el => el.innerText), /Thu/);
    await sleep(1500);

    // Asked: it is not due again until Thursday
    await setBackgroundClock(now + DAY);
    await extension.removeStorage(['followup-day']);
    assert.deepEqual((await request({ type: 'followups_today' }))?.result, [], 'Wednesday: nobody to chase');
    await setBackgroundClock(now + 2 * DAY);
    await extension.removeStorage(['followup-day']);
    assert.deepEqual(
      ((await request({ type: 'followups_today' }))?.result ?? []).map(item => item.taskId),
      [QUIET],
      'Thursday: due again',
    );
    await setBackgroundClock(now);

    await clickTestId('followup-done', card);
    const done = await waitFor(async () => {
      const item = await readTask(QUIET);
      return item.status === 'done' ? item : null;
    }, 'Done to close it');
    assert.equal(done.doneBy, 'avi');
    await sleep(1200);

    // The Tasks page shows it done
    await openPlace('Tasks');
    await panel.waitForSelector('section[aria-label="Tasks"]', { timeout: 10000 });
    await sleep(500);
    await clickText('Done');
    await waitFor(
      () =>
        panel.evaluate(
          id => document.querySelector(`[data-task-id="${id}"] input[type="checkbox"]`)?.checked === true,
          QUIET,
        ),
      'the done list to show it ticked',
    );
    await sleep(1200);
  });

  assert.equal((await readTask(MINE)).status, 'open', 'Avi’s own tasks are untouched');
  assert.deepEqual(panelErrors, []);
});
