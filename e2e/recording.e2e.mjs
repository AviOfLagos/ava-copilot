import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { startMockMcp } from './mock-mcp.mjs';
import { createMockDrive, interceptDrive } from './mock-drive.mjs';
import { launchExtension, openSession, pressToolbarButton, sleep } from './harness.mjs';

/**
 * A screen recording for a task (docs/pm-desk.md, Part 7), in a real browser: the toolbar button opens the side
 * panel on a meeting tab and meeting notes start; the Tasks page's "Record screen" click records another tab (picked
 * by Chrome's auto-select flag, as Avi would pick it) while the notes keep running; Stop ends it.
 *
 * - Drive off: the file is downloaded from the panel, plays (ffprobe decodes its frames), the task says where it
 *   is, and the Inbox offers to connect Drive.
 * - Drive on: a sign-in to the mock OAuth server stands in for the `google_drive` connector, and every request to
 *   www.googleapis.com is answered by ./mock-drive.mjs (never Google). The first upload piece is dropped; the
 *   upload carries on into one private file. Share makes it open signed out and puts the link on the task; Stop
 *   sharing closes it again.
 *
 * RECORD_SECONDS (default 30) is how long the Drive-off recording runs. E2E_FRAMES=<dir> saves the panel every
 * 250 ms while the Drive-on test runs, for a clip.
 */

const TARGET_TITLE = 'Recording target';
const RECORD_SECONDS = Number(process.env.RECORD_SECONDS ?? 30);
const FRAMES = process.env.E2E_FRAMES;
const TARGET = `data:text/html,${encodeURIComponent(`<!doctype html><title>${TARGET_TITLE}</title>
<body style="margin:0;background:#123"><canvas id="c" width="640" height="360"></canvas><script>
const c = document.getElementById('c').getContext('2d'); let n = 0;
(function draw() { n++; c.fillStyle = 'hsl(' + (n % 360) + ',70%,50%)'; c.fillRect(0, 0, 640, 360);
c.fillStyle = '#fff'; c.font = '48px sans-serif'; c.fillText('Frame ' + n, 40, 200); requestAnimationFrame(draw); })();
const a = new AudioContext(); const o = a.createOscillator(); o.frequency.value = 440; o.connect(a.destination); o.start();
</script>`)}`;

let mock;
let mcp;
let extension;
let drive;
let panel;
let meetingPage;
let downloads;

const panelText = async () => (await panel.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');

async function until(check, what, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${what}. Panel: ${(await panelText()).slice(0, 700)}`);
}

function readStore(page, store, database = 'avi-copilot') {
  return page.evaluate(
    (store, database) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open(database);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          if (!open.result.objectStoreNames.contains(store)) {
            open.result.close();
            return resolve([]);
          }
          const all = open.result.transaction(store).objectStore(store).getAll();
          all.onsuccess = () => {
            resolve(all.result.map(row => ({ ...row, data: undefined })));
            open.result.close();
          };
          all.onerror = () => reject(all.error);
        };
      }),
    store,
    database,
  );
}

const recordings = () => readStore(panel, 'recordings', 'ava-recordings');

/** A real click (Chrome counts it as the user's), on the first button whose text or label matches. */
async function press(page, label) {
  const handle = await page.waitForFunction(
    label =>
      [...document.querySelectorAll('button, [role="menuitem"]')].find(
        b => b.innerText.trim() === label || b.getAttribute('aria-label') === label,
      ),
    { timeout: 20000, polling: 250 },
    label,
  );
  await handle.asElement().click();
}

function clickByName(page, label) {
  return page.evaluate(label => {
    const element = [...document.querySelectorAll('button, [role="menuitem"], a')].find(
      el => el.innerText?.trim() === label || el.getAttribute('aria-label') === label,
    );
    element?.click();
    return Boolean(element);
  }, label);
}

function request(page, message) {
  return page.evaluate(
    async message => chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() }),
    message,
  );
}

async function addTask(title) {
  const reply = await request(panel, { type: 'tasks_add', title, workspaceId: null, ownerName: '', due: '' });
  assert.equal(reply.type, 'tasks_ok', JSON.stringify(reply));
  return reply.result;
}

async function openTasks() {
  await panel.bringToFront();
  await clickByName(panel, 'Menu');
  await sleep(300);
  await until(() => clickByName(panel, 'Tasks'), 'Tasks in the drawer');
  await panel.waitForSelector('section[aria-label="Tasks"]', { timeout: 10000 });
}

/** Saves the panel every 250 ms while `run` goes, when FRAMES is set. */
async function frames(page, run) {
  if (!FRAMES) return run();
  fs.mkdirSync(FRAMES, { recursive: true });
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

const meetingStatus = async () =>
  (await readStore(panel, 'meetings')).sort((a, b) => b.startedAt - a.startedAt)[0]?.status;

/** One recording from the Record button to Stop, checking the notes keep running throughout. */
async function recordFor(task, seconds) {
  await press(panel, `Record screen for ${task.title}`);
  await panel.waitForSelector('[data-recording="live"]', { timeout: 20000 });
  assert.equal(await meetingStatus(), 'recording', 'meeting notes keep running when the recording starts');
  const bar = await panel.$eval('[data-recording="live"]', el => el.innerText.replace(/\s+/g, ' '));
  assert.match(bar, /Recording 0:0\d/);
  assert.match(bar, new RegExp(task.title));
  await sleep(seconds * 1000);
  const timer = await panel.$eval('[data-recording-timer]', el => el.innerText);
  assert.ok(Number(timer.split(':')[0]) * 60 + Number(timer.split(':')[1]) >= seconds - 1, `timer at ${timer}`);
  assert.equal(await meetingStatus(), 'recording', 'meeting notes still running while it records');
  await press(panel, 'Stop recording');
  await until(async () => !(await panel.$('[data-recording="live"]')), 'the red mark to go');
  assert.equal(await meetingStatus(), 'recording', 'meeting notes still running after it stopped');
  return until(
    async () => (await recordings()).find(r => r.taskId === task.id && r.status !== 'recording'),
    'the record',
  );
}

before(async () => {
  downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-recording-downloads-'));
  mock = await startMockLlm({});
  mcp = await startMockMcp();
  drive = createMockDrive();
  extension = await launchExtension(mock, {
    args: [
      `--auto-select-tab-capture-source-by-title=${TARGET_TITLE}`,
      // A fake microphone the panel may use (granted below); tab capture still works without the fake UI flag
      '--use-fake-device-for-media-stream',
    ],
  });
  const browserCdp = await extension.browser.target().createCDPSession();
  await browserCdp.send('Browser.grantPermissions', { origin: extension.origin, permissions: ['audioCapture'] });
  await browserCdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
    eventsEnabled: true,
  });
  await interceptDrive(extension.browser, drive, extension.origin);

  // Meeting notes as meeting.e2e sets them up: short chunks, captions off, the scripted model writing it down
  await extension.setStorage({
    'speech-to-text-model': { speechToTextModel: { provider: 'mock', modelName: 'scripted' } },
    'meeting-settings': {
      liveCaptions: false,
      includeMic: false,
      keepAudio: false,
      consentShown: true,
      chunkSeconds: 3,
      firstChunkSeconds: 2,
      overlapSeconds: 1,
      summaryEverySeconds: 30,
      autoNotes: false,
    },
  });

  // The tab to record, then the meeting, whose toolbar button opens the panel
  const target = await extension.browser.newPage();
  await target.goto(TARGET);
  meetingPage = await extension.browser.newPage();
  await meetingPage.goto(`http://127.0.0.1:${mock.port}/meeting.html`);
  panel = await pressToolbarButton(extension, meetingPage);
  await panel.waitForSelector('textarea', { timeout: 20000 });
  await press(panel, 'Take meeting notes');
  await panel.waitForFunction(() => /Recording ·|Tell people you are taking notes/.test(document.body.innerText), {
    polling: 250,
    timeout: 15000,
  });
  if ((await panelText()).includes('Tell people you are taking notes')) await press(panel, 'Start notes');
  await until(async () => (await meetingStatus()) === 'recording', 'meeting notes to start');
});

after(async () => {
  await extension?.close();
  await mcp?.close();
  await mock?.close();
  if (downloads) fs.rmSync(downloads, { recursive: true, force: true });
});

test('nothing records without a click', async () => {
  await addTask('Check the signup form');
  await openTasks();
  await panel.waitForSelector('[aria-label="Record screen for Check the signup form"]');
  await sleep(2000);
  assert.equal((await recordings()).length, 0);
  assert.equal(await panel.$('[data-recording]'), null, 'no picker and no red mark');
});

test('with Drive off, a click records a tab with voice while notes run; the file plays and is on disk', async () => {
  await openTasks();
  const task = await addTask('Fix the login page');
  const record = await recordFor(task, RECORD_SECONDS);
  assert.equal(record.surface, 'browser');
  assert.equal(record.withTabAudio, true, 'the tab sound is in it');
  assert.equal(record.withMic, true, 'the microphone is in it');
  assert.ok(record.durationMs >= (RECORD_SECONDS - 1) * 1000);

  // Neither Drive nor Ava Brain: the panel downloads it, and the task says where
  const saved = await until(async () => {
    const found = (await recordings()).find(r => r.id === record.id);
    return found?.status === 'saved' && found;
  }, 'the download');
  assert.deepEqual(saved.saved.where, 'download');
  const file = path.join(downloads, saved.fileName);
  await until(() => fs.existsSync(file) && fs.statSync(file).size === saved.bytes, 'the file on disk', 30000);
  await until(
    async () => (await panelText()).includes(`Downloaded to your Downloads folder as ${saved.fileName}`),
    'the task to say where',
  );

  // It plays: ffprobe decodes every video frame, and finds the sound
  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=codec_type,codec_name,nb_read_frames,width',
      '-of',
      'json',
      file,
    ]).toString(),
  );
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  assert.ok(['vp8', 'vp9'].includes(video.codec_name), JSON.stringify(probe));
  assert.ok(Number(video.nb_read_frames) > RECORD_SECONDS * 5, `${video.nb_read_frames} frames`);
  assert.equal(audio?.codec_name, 'opus');

  // And the Inbox offers, once, to connect Drive
  const inbox = await readStore(panel, 'inbox');
  assert.equal(inbox.filter(item => item.id === 'system|recordings-connect-drive').length, 1);
});

test('with Drive on, the upload survives a dropped connection as one private file; Share and Stop sharing', async () => {
  // Sign in to the mock OAuth server in a panel tab, then mark that connector as the Drive one
  const setup = await openSession(extension, mock);
  await setup.panel.setViewport({ width: 400, height: 1100 });
  await setup.panel.bringToFront();
  await clickByName(setup.panel, 'Menu');
  await sleep(300);
  await setup.openAccountMenu();
  await until(() => clickByName(setup.panel, 'Connectors'), 'Connectors');
  await setup.panel.waitForSelector('[data-place="connectors"]', { timeout: 10000 });
  await until(() => clickByName(setup.panel, 'Add custom server'), 'Add custom server');
  await setup.panel.waitForSelector('#conn-url', { timeout: 5000 });
  for (const [selector, value] of [
    ['#conn-name', 'Drive stand-in'],
    ['#conn-url', mcp.oauthUrl],
  ]) {
    await setup.panel.evaluate(
      (selector, value) => {
        const input = document.querySelector(selector);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      selector,
      value,
    );
  }
  await setup.panel.evaluate(() => {
    const form = document.querySelector('form');
    [...form.querySelectorAll('button')].find(b => b.innerText.trim() === 'Add connector').click();
  });
  await setup.panel.waitForSelector('[data-connector="Drive stand-in"] [data-connector-status="connected"]', {
    timeout: 30000,
  });
  await setup.panel.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onsuccess = () => {
          const store = open.result.transaction('connectors', 'readwrite').objectStore('connectors');
          const all = store.getAll();
          all.onsuccess = () => {
            const connector = all.result.find(item => item.name === 'Drive stand-in');
            store.put({ ...connector, catalogId: 'google_drive' }).onsuccess = () => resolve(true);
          };
        };
        open.onerror = () => reject(open.error);
      }),
  );
  await setup.panel.close();

  await openTasks();
  const task = await addTask('Show the new onboarding');
  drive.dropNextPiece();
  await frames(panel, async () => {
    await sleep(600);
    const record = await recordFor(task, 6);
    const saved = await until(
      async () => {
        const found = (await recordings()).find(r => r.id === record.id);
        return found?.status === 'saved' && found;
      },
      'the upload',
      60000,
    );
    await until(
      async () => (await panelText()).includes('In Drive, private · Ava recordings / No workspace'),
      'the row to say Drive',
    );
    await sleep(1200);

    // One file, in "Ava recordings / No workspace", private, with every byte
    const files = drive.uploads();
    assert.equal(files.length, 1, 'one file, not two');
    assert.equal(drive.sessions.size, 1, 'one upload session');
    assert.equal(files[0].size, saved.bytes);
    assert.equal(files[0].name, saved.fileName);
    const folder = drive.files.get(files[0].parents[0]);
    assert.equal(folder.name, 'No workspace');
    assert.equal(drive.files.get(folder.parents[0]).name, 'Ava recordings');
    assert.equal(drive.opensSignedOut(files[0].id), false, 'private until shared');
    const puts = drive.calls.filter(call => call.method === 'PUT');
    assert.ok(puts.length >= 2, 'the dropped piece was asked about and sent again');

    // Share: anyone with the link can comment, and the link is on the task
    await press(panel, 'Share');
    await until(async () => (await panelText()).includes('Shared: anyone with the link can comment'), 'shared');
    assert.equal(drive.opensSignedOut(files[0].id), true, 'the link opens signed out');
    const anyone = files[0].permissions.find(permission => permission.type === 'anyone');
    assert.equal(anyone.role, 'commenter');
    const withLink = (await readStore(panel, 'tasks')).find(item => item.id === task.id);
    assert.equal(withLink.links.length, 1);
    assert.match(withLink.links[0].url, new RegExp(files[0].id));
    await sleep(1500);

    // Stop sharing: the link stops working and leaves the task
    await press(panel, 'Stop sharing');
    await until(async () => (await panelText()).includes('In Drive, private'), 'private again');
    assert.equal(drive.opensSignedOut(files[0].id), false);
    assert.equal((await readStore(panel, 'tasks')).find(item => item.id === task.id).links.length, 0);
    await sleep(1200);
  });
});
