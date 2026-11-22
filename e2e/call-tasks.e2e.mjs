import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, sleep } from './harness.mjs';

/**
 * "Ava, note a task for Ada" on a call (docs/pm-desk.md, Part 6), in a real browser: a Google Meet call served in
 * place of the real one plays a caption fixture once its captions are on. Avi's own caption blocks carry the page's
 * own-line mark (`data-self-name`, CALL_DOM.selfLineSelectors); everyone else's do not, including a guest named
 * "You" and a guest named "Avi". No real call, no model (the scripted mock writes the note), nothing sent.
 *
 * E2E_CAPTURE=<file.mp4> records the panel tab only (never the screen) while it runs.
 */

let mock;
let extension;
let panel;

// The caption fixture: each turn is [speaker, marked as the user's own, steps], each step [ms to wait, the block's
// whole words]. Avi's line is rewritten three times while it grows, once more after it settled, then grows a
// follow-on sentence.
const FIXTURE = [
  [
    'Ben Okafor',
    false,
    [
      [300, 'Ava, note a task'],
      [300, 'Ava, note a task for Ben: book the venue.'],
    ],
  ],
  [
    'You',
    true,
    [
      [300, 'Ava note a task'],
      [300, 'Ava note a task for Eda send the'],
      [300, 'Ava, note a task for Ada: send the deck'],
      // Stands for longer than 1.5 s: the reader takes it now, the task is made from it
      [2600, 'Ava, note a task for Ada: send the deck by Friday.'],
      [2600, 'Ava, note a task for Ada: send the deck by Friday. Also add the pricing slide.'],
    ],
  ],
  ['You', false, [[2600, 'Ava, note a task for Ben: order the badges.']]],
  ['Avi', false, [[2600, 'Ava, note a task for Ben: print the posters.']]],
];

const meetCall = ({
  guestFirst,
}) => `<!doctype html><html lang="en"><head><title>Meet – abc-defg-hij</title></head><body>
<div role="toolbar" id="toolbar">
  <button aria-label="Turn on captions (c)" id="cc"><i aria-hidden="true">closed_caption_off</i></button>
  <button aria-label="Leave call"><i aria-hidden="true">call_end</i></button>
</div>
<script>
  const FIXTURE = ${JSON.stringify(guestFirst ? [['You', false, [[300, 'Hello everyone, can you hear me?']]], ...FIXTURE] : FIXTURE)};
  const cc = document.getElementById('cc');
  let region = null;
  window.played = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function play() {
    await wait(1500);
    for (const [speaker, own, steps] of FIXTURE) {
      const block = document.createElement('div');
      block.className = 'nMcdL';
      // Avi's own line: the page marks it (an attribute, never the name shown)
      block.innerHTML = (own ? '<div class="KcIKyf" data-self-name="Avi Example">' : '<div class="KcIKyf">') +
        '<span class="NWpY1d"></span></div><div class="ygicle"></div>';
      block.querySelector('.NWpY1d').textContent = speaker;
      region.append(block);
      while (region.children.length > 3) region.firstElementChild.remove();
      for (const [ms, words] of steps) {
        await wait(ms);
        block.querySelector('.ygicle').textContent = words;
        window.played.push({ speaker, own, words, at: Date.now() });
      }
      await wait(2600);
    }
    window.fixtureDone = true;
  }
  cc.addEventListener('click', () => {
    if (region) return;
    cc.setAttribute('aria-label', 'Turn off captions (c)');
    cc.querySelector('i').textContent = 'closed_caption';
    region = document.createElement('div');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Captions');
    document.body.append(region);
    void play();
  });
  window.leaveCall = () => {
    document.getElementById('toolbar').remove();
    region?.remove();
    document.body.insertAdjacentHTML('beforeend', '<h1>You left the meeting</h1><button>Rejoin</button><button>Return to home screen</button>');
  };
</script></body></html>`;

async function joinMeetCall(options, code = 'abc-defg-hij') {
  const meet = await extension.browser.newPage();
  await meet.setRequestInterception(true);
  meet.on('request', request =>
    request.url().startsWith('https://meet.google.com/')
      ? request.respond({ status: 200, contentType: 'text/html', body: meetCall(options) })
      : request.continue(),
  );
  await meet.goto(`https://meet.google.com/${code}`);
  return meet;
}

const readTable = name =>
  panel.evaluate(
    name =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction(name).objectStore(name).getAll();
          all.onsuccess = () => resolve(all.result);
        };
      }),
    name,
  );

const waitFor = async (check, what, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const latestMeeting = async () => (await readTable('meetings')).sort((a, b) => b.startedAt - a.startedAt)[0];
const panelText = async () => (await panel.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
const visible = (text, timeout = 20000) =>
  panel.waitForFunction(text => document.body.innerText.includes(text), { polling: 300, timeout }, text);
const press = async label => {
  await panel.waitForFunction(
    label =>
      [...document.querySelectorAll('button')].some(
        b => b.innerText.trim() === label || b.getAttribute('aria-label') === label,
      ),
    { polling: 300, timeout: 20000 },
    label,
  );
  const handle = await panel.evaluateHandle(
    label =>
      [...document.querySelectorAll('button')].find(
        b => b.innerText.trim() === label || b.getAttribute('aria-label') === label,
      ),
    label,
  );
  await handle.asElement().click();
};

/** Screenshots of the panel tab every 250 ms, joined into a clip by ffmpeg. */
function recorder(page, out) {
  if (!out) return { stop: async () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-tasks-capture-'));
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
        '4',
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

before(async () => {
  mock = await startMockLlm({});
  // The call's tab is in the background while the panel is in front: its timers must keep the fixture's pace
  extension = await launchExtension(mock, {
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  panel = await extension.browser.newPage();
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.waitForSelector('textarea');
  await panel.setViewport({ width: 420, height: 900 });
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

test('Avi says "Ava, note a task for Ada": one task, extended, then a list he edits before "Looks right"', async () => {
  const before = (await readTable('meetings')).length;
  const meet = await joinMeetCall({ guestFirst: false });
  const meeting = await waitFor(
    async () => (await readTable('meetings')).length > before && (await latestMeeting()),
    'notes to start on their own',
  );
  assert.equal(meeting.source, 'captions');

  await panel.bringToFront();
  const capture = recorder(panel, process.env.E2E_CAPTURE);
  try {
    // The panel says spoken tasks are on, and how they are heard
    await panel.waitForSelector('[data-testid="calltasks-status"][data-signal="captions"]', { timeout: 30000 });
    await visible('Spoken tasks are on');

    // The task exists within five seconds of Avi's words standing still
    const task = await waitFor(
      async () => (await readTable('tasks')).find(t => t.ownerName === 'Ada'),
      'the task',
      45000,
    ).catch(async error => {
      const page = await meet.evaluate(() => ({
        played: window.played,
        cc: document.getElementById('cc')?.getAttribute('aria-label'),
      }));
      const m = await latestMeeting();
      throw new Error(
        `${error.message}. Page: ${JSON.stringify(page)} Meeting: ${JSON.stringify({ source: m.source, captionsOn: m.captionsOn, callTasks: m.callTasks, warnings: m.warnings })} Segments: ${JSON.stringify((await readTable('segments')).map(x => [x.speaker, x.text]))}`,
      );
    });
    // Measured from the first time Avi's line showed a whole command (a name and words after it)
    const own = (await meet.evaluate(() => window.played)).filter(step => step.own);
    const said = own.find(step => /for [AE]da:? send/.test(step.words));
    assert.ok(task.createdAt - said.at <= 5000, `stored ${task.createdAt - said.at} ms after the words`);
    assert.equal(task.source.kind, 'meeting');
    assert.equal(task.source.id, meeting.id);

    // A small card, with Edit, Discard and the recording offer
    await panel.waitForSelector('[data-testid="calltask-card"]', { timeout: 10000 });
    await visible('Task for Ada');
    await visible('Record the screen for this?');

    // The follow-on sentence extends it
    await waitFor(async () => (await readTable('tasks')).find(t => t.id === task.id)?.detail, 'the follow-on', 20000);
    await visible('add the pricing slide');

    // The rest of the call: Ben, a guest named "You" and a guest named "Avi" say the phrase; nothing comes of it
    // (the note's own action items join the board only when the call ends)
    await waitFor(() => meet.evaluate(() => window.fixtureDone === true), 'the fixture to finish', 60000);
    await sleep(2500);
    const tasks = await readTable('tasks');
    assert.equal(tasks.length, 1, JSON.stringify(tasks.map(t => [t.title, t.ownerName])));
    assert.equal(tasks[0].title, 'send the deck by Friday');
    assert.equal(tasks[0].detail, 'add the pricing slide');
    assert.equal((await latestMeeting()).callTasks.tasks.length, 1);
    await sleep(800);

    // The call ends: the note is written, and its chat has "Tasks from this call"
    await press('Open meeting');
    await meet.evaluate(() => window.leaveCall());
    await waitFor(async () => (await latestMeeting()).status === 'done', 'the note', 60000);
    await press('Ask about it');
    await panel.waitForSelector('[data-testid="calltasks-list"]', { timeout: 20000 });
    await visible('Tasks from this call');
    const group = await panel.$eval('[data-testid="calltasks-person"]', el => el.getAttribute('data-person'));
    assert.equal(group, 'Ada');
    await sleep(1000);

    // Edited before anything is sent
    await press(`Edit "send the deck by Friday"`);
    await panel.waitForSelector('input[aria-label="What is to be done"]');
    await panel.$eval('input[aria-label="What is to be done"]', input => input.select());
    await panel.type('input[aria-label="What is to be done"]', 'Send the launch deck by Friday', { delay: 25 });
    await press('Save');
    await waitFor(
      async () => (await readTable('tasks')).find(t => t.id === task.id).title === 'Send the launch deck by Friday',
      'the edit to be saved',
      10000,
    ).catch(async error => {
      const list = await panel.$eval('[data-testid="calltasks-list"]', el => el.innerText).catch(() => '');
      throw new Error(
        `${error.message}. List: ${list} Tasks: ${JSON.stringify((await readTable('tasks')).map(t => t.title))}`,
      );
    });
    await visible('Send the launch deck by Friday');
    let state = (await latestMeeting()).callTasks;
    assert.equal(state.confirmedAt, undefined, 'nothing passed on before "Looks right"');
    assert.equal(state.sent, undefined);
    await sleep(1000);

    // "Looks right" passes it on: Avi's own WhatsApp (held here: Ava Brain is not linked), and the draft button
    await press('Looks right');
    await waitFor(async () => (await latestMeeting()).callTasks.confirmedAt, '"Looks right"').catch(async error => {
      const list = await panel.$eval('[data-testid="calltasks-list"]', el => el.innerText).catch(() => 'no list');
      throw new Error(`${error.message}. List: ${list.replace(/\s+/g, ' ')}`);
    });
    await visible('Draft a message to Ada');
    state = (await latestMeeting()).callTasks;
    assert.deepEqual(
      state.sent.map(item => item.name),
      ['Ada'],
    );
    await sleep(1500);
  } finally {
    await capture.stop();
    // A failed run must not leave its call recording for the next test
    if ((await latestMeeting())?.status === 'recording') {
      await meet.evaluate(() => window.leaveCall()).catch(() => {});
      await waitFor(async () => (await latestMeeting()).status !== 'recording', 'the call to end', 60000).catch(
        () => {},
      );
    }
  }
  await meet.close();
});

test("captions that do not mark Avi's own lines turn spoken tasks off, and the panel says so", async () => {
  const before = (await readTable('meetings')).length;
  const meet = await joinMeetCall({ guestFirst: true }, 'bcd-efgh-ijk');
  const meeting = await waitFor(
    async () => (await readTable('meetings')).length > before && (await latestMeeting()),
    'notes to start on their own',
  );
  await panel.bringToFront();
  // The first line is labelled "You" without the mark: captions cannot tell Avi from a guest on this call
  await panel.waitForSelector('[data-testid="calltasks-status"][data-signal="off"]', { timeout: 30000 });
  await visible('Spoken tasks are off for this call');
  assert.equal((await readTable('meetings')).find(m => m.id === meeting.id).callTasks.selfMarkerMissing, true);
  await waitFor(() => meet.evaluate(() => window.fixtureDone === true), 'the fixture to finish', 60000);
  await sleep(2500);
  // Avi's own marked line came later, which proves the mark works: commands come back on, his task is heard (the
  // board matches it to the one from the first call), and nobody else's
  await panel.waitForSelector('[data-testid="calltasks-status"][data-signal="captions"]', { timeout: 10000 });
  const heard = (await readTable('meetings')).find(m => m.id === meeting.id).callTasks.tasks;
  assert.equal(heard.length, 1);
  assert.equal(heard[0].ownerName, 'Ada');
  assert.ok(!(await readTable('tasks')).some(task => task.ownerName === 'Ben'), 'no task for Ben from a guest');
  await meet.evaluate(() => window.leaveCall());
  await waitFor(async () => (await latestMeeting()).status === 'done', 'the note', 60000);
  await meet.close();
});
