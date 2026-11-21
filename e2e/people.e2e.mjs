import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';
import { handleKey, nameKey, scopedKey } from '../src/storage/lib/people/names.ts';

/**
 * What the owner sees of People (docs/pm-desk.md 5.4 and 5.5): a "Who's who" card in the Inbox, answered there;
 * the answer shows on the People page as another name of that person; and the name is not asked about again.
 * The names are written into the extension's database as the background leaves them after two Slack sightings
 * (the learning itself is unit-tested in src/background/people/__tests__). Made-up people only.
 *
 * E2E_CAPTURE=<file.mp4> records the panel tab (never the screen) while it runs.
 */

const DAY = 'daily:2026-11-21';
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

const now = Date.now();
const person = {
  id: 'per_adaeze0001',
  name: 'Adaeze Okafor',
  aliases: [],
  handles: [],
  emails: ['ada@example.test'],
  phones: [],
  workspaceIds: [],
  seen: [{ source: 'calendar', workspaceId: null, at: now - 86_400_000 }],
  nameKey: nameKey('Adaeze Okafor'),
  aliasKeys: [],
  handleKeys: [],
  createdAt: now,
  updatedAt: now,
};

const candidate = (id, text, handle, over = {}) => ({
  id,
  key: scopedKey(null, nameKey(text)),
  text,
  otherTexts: [],
  workspaceId: null,
  emails: [],
  phones: [],
  handles: [{ kind: 'slack', value: handle, workspaceId: null }],
  handleKeys: [handleKey({ kind: 'slack', value: handle })],
  sightings: [
    { source: 'slack', at: now - 86_400_000, context: 'sent you a message on Slack', ref: `slack-web|${handle}|d1` },
    { source: 'slack', at: now, context: 'sent you a message on Slack', ref: `slack-web|${handle}|d2` },
  ],
  count: 2,
  taskIds: [],
  tasks: 0,
  meetingIds: [],
  suggestedPersonId: null,
  candidatePersonIds: [],
  likeCandidateId: null,
  status: 'asked',
  askedOn: DAY,
  personId: null,
  firstAt: now - 86_400_000,
  lastAt: now,
  ...over,
});

/** Screenshots of one tab every 250 ms, joined into a clip by ffmpeg. */
function recorder(page, out) {
  if (!out) return { stop: async () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-capture-'));
  let n = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      await page
        .screenshot({ path: path.join(dir, `f-${String(n++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 80 })
        .catch(() => n--);
      await sleep(250);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      execFileSync(process.env.FFMPEG ?? 'ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-framerate',
        '2',
        '-i',
        path.join(dir, 'f-%05d.jpg'),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        out,
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const visible = (session, text) =>
  session.panel.waitForFunction(text => document.body.innerText.includes(text), { polling: 300, timeout: 15000 }, text);

test("a Who's who answer is remembered: on the People page, and never asked again", async () => {
  const session = await openSession(extension, mock);
  const { panel } = session;
  await panel.setViewport({ width: 420, height: 820 });
  await writeStore(panel, 'people', [person]);
  await writeStore(panel, 'peopleNames', [
    candidate('nam_adao00001', 'Ada O.', 'D0ADA', { suggestedPersonId: person.id }),
    candidate('nam_kunle0001', 'dev.kunle', 'D0KUNLE'),
  ]);
  await writeStore(panel, 'inbox', [
    {
      id: `people|${DAY}`,
      source: 'people',
      externalId: DAY,
      kind: 'alert',
      title: "Who's who: 2 names to sort",
      body: '“Ada O.” — sent you a message on Slack\n“dev.kunle” — sent you a message on Slack',
      links: [],
      priority: 'low',
      status: 'unread',
      snoozeUntil: null,
      workspaceId: null,
      agentId: null,
      runId: null,
      approval: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await panel.bringToFront();
  const capture = recorder(panel, process.env.E2E_CAPTURE);
  try {
    await session.click('Menu');
    await session.click('Inbox');
    await visible(session, "Who's who: 2 names to sort");
    await session.click("Who's who: 2 names to sort").catch(async () => {
      await panel.evaluate(() =>
        [...document.querySelectorAll('li, button')].find(el => el.innerText.includes("Who's who: 2"))?.click(),
      );
    });
    await visible(session, 'Yes, Adaeze Okafor');
    await sleep(600);

    // The match code found is offered first; one click settles it
    await session.click('Yes, Adaeze Okafor');
    await visible(session, 'saved as Adaeze Okafor');
    await sleep(600);

    // A new person, named by the owner
    await session.click('New person');
    await panel.waitForSelector('input[aria-label="Name"]');
    await panel.$eval('input[aria-label="Name"]', input => input.select());
    await panel.type('input[aria-label="Name"]', 'Kunle Ade', { delay: 40 });
    await session.click('Save');
    await visible(session, 'saved as Kunle Ade');
    await visible(session, 'All sorted');
    await sleep(800);

    // The People page shows each answer as another name of that person
    await session.click('Open People');
    await panel.waitForSelector('[data-testid="person-row"]', { timeout: 15000 });
    await visible(session, 'Kunle Ade');
    const rows = await panel.evaluate(() =>
      [...document.querySelectorAll('[data-testid="person-row"]')].map(row => ({
        name: row.getAttribute('data-person'),
        aliases: [...row.querySelectorAll('[data-testid="person-alias"]')].map(alias =>
          alias.innerText.replace(/\s+/g, ' ').trim(),
        ),
      })),
    );
    assert.deepEqual(rows, [
      { name: 'Adaeze Okafor', aliases: ['Ada O. · everywhere'] },
      { name: 'Kunle Ade', aliases: ['dev.kunle · everywhere'] },
    ]);
    assert.match(await session.panelText(), /To sort \(0\)/);
    await sleep(1200);
    await session.click('To sort (0)');
    await visible(session, 'Nothing to sort');
    await sleep(1000);
  } finally {
    await capture.stop();
  }

  // Remembered: both names are settled, so no card asks about them again
  const names = await readStore(panel, 'peopleNames');
  assert.deepEqual(names.map(name => [name.text, name.status]).sort(), [
    ['Ada O.', 'settled'],
    ['dev.kunle', 'settled'],
  ]);
  const people = await readStore(panel, 'people');
  const ada = people.find(item => item.name === 'Adaeze Okafor');
  // The Slack handle came with the answer, so the next message from that DM is Adaeze whatever name it shows
  assert.ok(ada.handleKeys.includes('slack:D0ADA'), JSON.stringify(ada.handleKeys));
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});
