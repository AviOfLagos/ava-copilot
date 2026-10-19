import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, pressToolbarButton, restartServiceWorker, sleep } from './harness.mjs';

/**
 * End-to-end tests of meeting notes: recording a tab through the offscreen document, live
 * transcription, the rolling summary, the final note, an outage, and the captions fallback.
 * Headless Chrome captures a silent tab, so the scripted model supplies the words.
 */

let mock;
let extension;
let panel;
let meetingUrl;

const panelText = async () => (await panel.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
const waitForText = (text, timeout = 20000) =>
  panel.waitForFunction(t => document.body.innerText.includes(t), { timeout, polling: 250 }, text);
// Waits for the button first: a view opened by the click before renders a moment later
const click = async label => {
  await panel
    .waitForFunction(
      label =>
        [...document.querySelectorAll('button')].some(
          b => b.innerText.trim() === label || b.getAttribute('aria-label') === label,
        ),
      { timeout: 20000, polling: 250 },
      label,
    )
    .catch(() => {});
  await panel.evaluate(label => {
    const button = [...document.querySelectorAll('button')].find(
      b => b.innerText.trim() === label || b.getAttribute('aria-label') === label,
    );
    if (!button) throw new Error(`No button "${label}"`);
    button.click();
  }, label);
};
// Opens a section of the meeting view: Summary, Live, Transcript or Ask
const tab = async label => {
  await panel.waitForFunction(
    label => [...document.querySelectorAll('[role="tab"]')].some(t => t.innerText.trim().startsWith(label)),
    { polling: 250, timeout: 10000 },
    label,
  );
  await panel.evaluate(
    label => [...document.querySelectorAll('[role="tab"]')].find(t => t.innerText.trim().startsWith(label)).click(),
    label,
  );
};
// A real click, which Chrome counts as a user gesture
const press = async label => {
  const handle = await panel.evaluateHandle(
    label =>
      [...document.querySelectorAll('button')].find(
        b => b.innerText.trim() === label || b.getAttribute('aria-label') === label,
      ),
    label,
  );
  await handle.asElement().click();
};
// Starts notes from the panel, getting past the first-run reminder when it shows
const startNotes = async () => {
  await panel.waitForSelector('button[aria-label="Take meeting notes"]');
  await press('Take meeting notes');
  await panel.waitForFunction(() => /Recording ·|Tell people you are taking notes/.test(document.body.innerText), {
    polling: 250,
    timeout: 10000,
  });
  if ((await panelText()).includes('Tell people you are taking notes')) await press('Start notes');
  await waitForText('Recording ·');
};

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

before(async () => {
  mock = await startMockLlm({});
  meetingUrl = `http://127.0.0.1:${mock.port}/meeting.html`;
  extension = await launchExtension(mock);
  // Short chunks and a quick summary, so a test meeting takes seconds. Live captions go to the
  // mock's Live API; a Gemini key turns them on, and the speech-to-text setting keeps
  // transcription on the scripted model.
  const providers = await extension.getStorage('llm-api-keys');
  await extension.setStorage({
    'llm-api-keys': {
      providers: {
        ...providers.providers,
        gemini: {
          name: 'Gemini',
          type: 'gemini',
          apiKey: 'test-key',
          modelNames: ['gemini-3.8-flash'],
          createdAt: Date.now(),
        },
      },
    },
    'speech-to-text-model': { speechToTextModel: { provider: 'mock', modelName: 'scripted' } },
    'meeting-settings': {
      liveCaptions: true,
      liveModel: 'gemini-3.8-live',
      liveEndpoint: `ws://127.0.0.1:${mock.port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
      includeMic: false,
      keepAudio: false,
      consentShown: false,
      chunkSeconds: 3,
      firstChunkSeconds: 2,
      overlapSeconds: 1,
      summaryEverySeconds: 4,
      silenceWarnSeconds: 3,
    },
  });
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

test('notes record the tab, transcribe live, summarize, and end in a note in its own thread', async () => {
  const web = await extension.browser.newPage();
  await web.goto(meetingUrl);
  panel = await pressToolbarButton(extension, web);
  await panel.waitForSelector('header');

  // The first recording asks the user to tell participants
  await press('Take meeting notes');
  await waitForText('Tell people you are taking notes');
  await press('Start notes');
  await waitForText('Recording ·');

  const worker = await (
    await extension.browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(extension.origin))
  ).worker();
  const tabId = await web
    .evaluate(() => 0)
    .then(() => worker.evaluate(async url => (await chrome.tabs.query({ url })).at(0)?.id, meetingUrl));
  assert.equal(await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId), 'REC');

  // The first words show within ten seconds
  const started = Date.now();
  await tab('Transcript');
  await waitForText('Line 1', 10000);
  assert.ok(Date.now() - started < 10000);

  await tab('Summary');
  await waitForText('Summary:');
  // Headless audio is silent, so the silence warning comes up
  await waitForText('No audio detected');

  // The offscreen document plays the tab back, so the user still hears the meeting
  const offscreen = await extension.browser.waitForTarget(t => t.url().endsWith('/offscreen.html'));
  assert.ok(offscreen, 'the recorder runs in an offscreen document');

  await sleep(3000);
  await click('Stop');
  await waitForText('Done ·');
  await waitForText('Stage 2 deadline is Friday');
  assert.match(await panelText(), /Ada: Draft the launch post \(due Thursday\)/);
  assert.equal(await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId), '');

  // Every chunk was 16 kHz WAV, every chunk was transcribed, and no audio was kept
  assert.ok(mock.meeting.clips.length >= 3);
  for (const clip of mock.meeting.clips) {
    assert.equal(clip.format, 'wav');
    assert.ok(clip.data.startsWith('UklGR'), 'a RIFF header');
  }
  const chunks = await readTable('audioChunks');
  assert.ok(chunks.every(chunk => chunk.status === 'done' && chunk.data === null));
  assert.equal(chunks.filter(chunk => chunk.final).length, 1);

  // The transcript is in order, each line once
  const segments = (await readTable('segments')).sort((a, b) => a.tStart - b.tStart);
  assert.deepEqual(
    segments.map(s => s.text),
    segments.map((_, i) => `Line ${i + 1}`),
  );

  // The note went into a thread, ready to be asked about
  const [meeting] = await readTable('meetings');
  assert.match(meeting.markdown, /## Action items\n\n- \[ \] \*\*Ada\*\*: Draft the launch post \(due Thursday\)/);
  const thread = (await readTable('threads')).find(t => t.id === meeting.threadId);
  assert.equal(thread.title, 'Meeting – Weekly sync notes');
  await click('Ask about it');
  await waitForText('Meeting notes');
  assert.match(await panelText(), /TL;DR/);
  await web.close();
});

test('live captions show while recording, and come back after the connection drops', async () => {
  const web = await extension.browser.newPage();
  await web.goto(meetingUrl);
  panel = await pressToolbarButton(extension, web);
  const before = mock.live.sessions.length;
  mock.live.dropAfter = mock.live.lines + 2;

  await startNotes();
  await waitForText(`Live words ${mock.live.lines + 1}`, 10000);
  // The connection drops after the second caption; captions resume in a resumed session
  await waitForText(`Live words ${mock.live.dropAfter + 1}`, 15000).catch(() => {});
  await panel.waitForFunction(
    n => document.body.innerText.includes(`Live words ${n}`),
    { polling: 250, timeout: 15000 },
    mock.live.lines,
  );

  const sessions = mock.live.sessions.slice(before);
  assert.ok(
    sessions.length >= 2,
    `it reconnected (sessions: ${sessions.length}, lines: ${mock.live.lines}, drop at: ${mock.live.dropAfter})`,
  );
  const [first, second] = sessions;
  assert.equal(first.key, 'test-key');
  assert.equal(first.setups[0].model, 'models/gemini-3.8-live');
  assert.deepEqual(first.setups[0].generationConfig, { responseModalities: ['AUDIO'], maxOutputTokens: 1 });
  assert.deepEqual(first.setups[0].inputAudioTranscription, {});
  assert.deepEqual([...first.mimeTypes], ['audio/pcm;rate=16000']);
  assert.deepEqual(second.setups[0].sessionResumption, { handle: `handle-${before + 1}` });

  // A question during the meeting is answered from the transcript and the newest captions
  await tab('Ask');
  await panel.type('input[aria-label="What did they decide about pricing?"]', 'What has been said so far?');
  // The tab is also called Ask: send with Enter
  await panel.keyboard.press('Enter');
  await waitForText('Answer from');
  const answer = await panelText();
  assert.match(answer, /What has been said so far\? Answer from [1-9]\d* transcript lines and \d+ live captions\./);

  // The summary refreshes on demand: with the schedule pushed out, only the button can refresh it
  const settings = await extension.getStorage('meeting-settings');
  await extension.setStorage({ 'meeting-settings': { ...settings, summaryEverySeconds: 600 } });
  const lines = mock.meeting.lines;
  await tab('Transcript');
  await panel.waitForFunction(
    n => document.body.innerText.includes(`Line ${n + 1}`),
    { polling: 250, timeout: 15000 },
    lines,
  );
  const summaries = mock.meeting.summaries;
  await tab('Summary');
  await click('Refresh now');
  for (let i = 0; i < 40 && mock.meeting.summaries === summaries; i++) await sleep(250);
  await extension.setStorage({ 'meeting-settings': settings });
  assert.ok(mock.meeting.summaries > summaries, 'Refresh now made a new summary');

  await click('Stop');
  await waitForText('Done ·');
  const meeting = (await readTable('meetings')).sort((a, b) => b.startedAt - a.startedAt)[0];
  assert.ok(meeting.liveCaptions.length >= 3);
  const thread = (await readTable('messages'))
    .filter(m => m.threadId === meeting.threadId)
    .sort((a, b) => a.seq - b.seq);
  assert.deepEqual(
    thread.slice(0, 2).map(m => [m.actor, m.content.slice(0, 12)]),
    [
      ['user', 'What has bee'],
      ['planner', 'Answer from '],
    ],
  );
  await web.close();
});

test('audio recorded during a transcription outage is transcribed once it recovers', async () => {
  const web = await extension.browser.newPage();
  await web.goto(meetingUrl);
  panel = await pressToolbarButton(extension, web);
  const linesBefore = mock.meeting.lines;
  mock.meeting.failTranscriptions = 3;

  // The reminder was shown once; notes now start straight away
  await press('Take meeting notes');
  await waitForText('Recording ·');
  await sleep(7000);
  await click('Stop');
  await waitForText('Done ·', 40000);

  const meetings = await readTable('meetings');
  const meeting = meetings.sort((a, b) => b.startedAt - a.startedAt)[0];
  const chunks = (await readTable('audioChunks')).filter(chunk => chunk.meetingId === meeting.id);
  assert.ok(chunks.length >= 3);
  assert.ok(
    chunks.every(chunk => chunk.status === 'done'),
    'no chunk was lost',
  );
  assert.equal(mock.meeting.failTranscriptions, 0, 'the outage happened');
  const segments = (await readTable('segments')).filter(s => s.meetingId === meeting.id);
  assert.equal(segments.length, mock.meeting.lines - linesBefore);
  await web.close();
});

test('a recording survives the service worker being killed, and loses no audio', async () => {
  const web = await extension.browser.newPage();
  await web.goto(meetingUrl);
  panel = await pressToolbarButton(extension, web);
  await press('Take meeting notes');
  await waitForText('Recording ·');
  await sleep(3000);

  // The recorder lives in the offscreen document and keeps writing while the worker is down
  await restartServiceWorker(extension, panel);
  await sleep(5000);
  await click('Stop');
  await waitForText('Done ·', 30000);

  const meeting = (await readTable('meetings')).sort((a, b) => b.startedAt - a.startedAt)[0];
  const chunks = (await readTable('audioChunks')).filter(chunk => chunk.meetingId === meeting.id);
  assert.ok(chunks.length >= 4, `chunks kept coming across the restart (${chunks.length})`);
  assert.deepEqual(
    chunks.map(chunk => chunk.index).sort((a, b) => a - b),
    chunks.map((_, i) => i),
    'no chunk is missing',
  );
  assert.ok(chunks.every(chunk => chunk.status === 'done'));
  await web.close();
});

test('without tab audio, notes come from the meeting captions', async () => {
  // A tab the extension was never invoked on cannot be recorded, but its captions can be read
  const web = await extension.browser.newPage();
  await web.goto(`${meetingUrl}?captions=1`);
  await web.bringToFront();
  await sleep(500);

  await press('Take meeting notes');
  await waitForText('from the meeting captions');
  await tab('Transcript');
  await waitForText('Captions line', 15000);
  await click('Stop');
  await waitForText('Done ·');

  const meeting = (await readTable('meetings')).sort((a, b) => b.startedAt - a.startedAt)[0];
  assert.equal(meeting.source, 'captions');
  const segments = (await readTable('segments')).filter(s => s.meetingId === meeting.id);
  assert.ok(segments.length > 0);
  assert.ok(segments.every(s => s.speaker === 'Ada' && /^Captions line \d+$/.test(s.text)));
  await web.close();
});

test('a tab that cannot be recorded and has no captions explains how to allow it', async () => {
  const web = await extension.browser.newPage();
  await web.goto(meetingUrl);
  await web.bringToFront();
  await sleep(500);

  await press('Take meeting notes');
  await waitForText('Click the Nex Copilot icon on the meeting tab');
  await web.close();
});

// A Google Meet call, served in place of the real one, shaped like Meet's own page (2025–2026): a toolbar
// whose buttons carry Material Symbols icons (`closed_caption_off`, `call_end`) and accessible names, and,
// once captions are on, a "Captions" region with one block per speaker turn (a name, then words that
// arrive a few at a time). Captions start OFF, as in Meet. `captions: false` is a call whose captions
// cannot be found or turned on. `leaveCall()` shows Meet's "You left the meeting" screen.
const meetCall = ({ captions }) => `<!doctype html><html lang="en"><head><title>Meet – abc-defg-hij</title></head><body>
<div role="toolbar" id="toolbar">
${
  captions
    ? '<button jsname="r8qRAd" aria-label="Turn on captions (c)" id="cc"><i class="google-symbols" aria-hidden="true">closed_caption_off</i></button>'
    : ''
}
  <button jsname="CQylAd" aria-label="Leave call"><i class="google-symbols" aria-hidden="true">call_end</i></button>
</div>
<script>
  window.ccPresses = 0;
  const cc = document.getElementById('cc');
  let region = null;
  let turn = 0;
  const speak = () => {
    turn += 1;
    const block = document.createElement('div');
    block.className = 'nMcdL bj4p3b';
    block.innerHTML = '<div class="adE6rb"><img alt=""><div class="KcIKyf jxFHg"><span class="NWpY1d">Ada</span></div></div><div class="ygicle VbkSUe"></div>';
    region.append(block);
    // Meet keeps a few turns on screen and drops the oldest
    while (region.children.length > 2) region.firstElementChild.remove();
    const words = ['Meet', 'caption', String(turn), 'ok'];
    let shown = 0;
    const grow = setInterval(() => {
      shown += 1;
      block.querySelector('.ygicle').textContent = words.slice(0, shown).join(' ');
      if (shown === words.length) {
        clearInterval(grow);
        // A pause between turns, longer than the reader waits for a caption to settle
        setTimeout(speak, 2500);
      }
    }, 300);
  };
  cc?.addEventListener('click', () => {
    window.ccPresses += 1;
    if (region) return;
    cc.setAttribute('aria-label', 'Turn off captions (c)');
    cc.querySelector('i').textContent = 'closed_caption';
    region = document.createElement('div');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Captions');
    region.tabIndex = 0;
    document.body.append(region);
    speak();
  });
  window.leaveCall = () => {
    document.getElementById('toolbar').remove();
    region?.remove();
    document.body.insertAdjacentHTML('beforeend', '<h1>You left the meeting</h1><button>Rejoin</button><button>Return to home screen</button>');
  };
</script></body></html>`;

async function joinMeetCall(options) {
  const meet = await extension.browser.newPage();
  await meet.setRequestInterception(true);
  meet.on('request', request =>
    request.url().startsWith('https://meet.google.com/')
      ? request.respond({ status: 200, contentType: 'text/html', body: meetCall(options) })
      : request.continue(),
  );
  await meet.goto('https://meet.google.com/abc-defg-hij');
  return meet;
}

const waitFor = async (check, what, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const latestMeeting = async () => (await readTable('meetings')).sort((a, b) => b.startedAt - a.startedAt)[0];
const shot = async name => {
  await panel.bringToFront();
  await panel.setViewport({ width: 400, height: 900 });
  await sleep(400);
  await panel.screenshot({ path: `${process.env.E2E_SHOTS ?? '/tmp'}/${name}.png` });
};

test('joining a call starts notes with no answer; the note is optional and adds context', async () => {
  const before = (await readTable('meetings')).length;
  const meet = await joinMeetCall({ captions: true });
  // Notes start on their own once the user is in the call: nothing is answered first
  const meeting = await waitFor(
    async () => (await readTable('meetings')).length > before && (await latestMeeting()),
    'notes to start on their own',
  );
  assert.equal(meeting.status, 'recording');
  assert.equal(meeting.auto, true);
  assert.equal(meeting.source, 'captions', 'never invoked on the tab: its captions are read');

  // The optional note shows in the panel and as an Inbox item, with a notification
  await waitForText('Add a note on what it');
  await waitForText('From the call');
  const inbox = await waitFor(
    async () => (await readTable('inbox')).find(item => item.id === `meetings|started:${meeting.id}`),
    'the Inbox item',
  );
  assert.equal(inbox.status, 'unread');
  const notifications = await panel.evaluate(() => chrome.notifications.getAll());
  assert.ok(Object.keys(notifications).includes(`meeting:${meeting.id}`));
  await shot('meeting-autojoin-prompt');

  // Meet's captions start off: the extension pressed the captions button itself, once, and saw them show
  assert.equal(await meet.evaluate(() => window.ccPresses), 1);
  assert.equal((await latestMeeting()).captionsOn, true);
  assert.ok(!(await latestMeeting()).warnings.includes('captions_off'));

  // Ignoring it changes nothing: the captions keep coming in, each turn once, with its speaker
  const lines = await waitFor(async () => {
    const found = (await readTable('segments')).filter(s => s.meetingId === meeting.id);
    return found.length >= 3 && found;
  }, 'captions in the transcript');
  for (const line of lines) {
    assert.equal(line.speaker, 'Ada');
    assert.match(line.text, /^Meet caption \d+ ok$/, 'a whole turn, not a word at a time');
  }
  assert.equal(new Set(lines.map(line => line.text)).size, lines.length, 'no turn twice');
  assert.equal((await latestMeeting()).status, 'recording');
  assert.equal((await latestMeeting()).topic, undefined);
  // With words in, the panel says notes are being taken
  await waitForText('Taking notes on this call');

  // Answering adds the note as context
  await panel.type('#auto-notes-note', 'Hiring plan with Ada');
  await press('Add note');
  await waitForText('Note added');
  const noted = await latestMeeting();
  assert.equal(noted.topic, 'Hiring plan with Ada');
  assert.equal(noted.topicSource, 'user');
  assert.equal(noted.status, 'recording');
  assert.equal((await readTable('inbox')).find(item => item.id === inbox.id).status, 'done');
  await shot('meeting-autojoin-noted');

  await press('Open meeting');
  await click('Stop');
  await waitFor(async () => (await latestMeeting()).status === 'done', 'the meeting to finish');
  await meet.close();
});

test('a call where nothing can be recorded raises a visible alert, and the toolbar click adds its audio', async () => {
  const settings = await extension.getStorage('meeting-settings');
  await extension.setStorage({ 'meeting-settings': { ...settings, nothingCapturedSeconds: 4 } });
  const before = (await readTable('meetings')).length;
  const meet = await joinMeetCall({ captions: false });
  const meeting = await waitFor(
    async () => (await readTable('meetings')).length > before && (await latestMeeting()),
    'notes to start on their own',
  );
  assert.equal(meeting.source, 'captions');

  // Nothing pretends to record: the call's captions could not be turned on, and the panel says so
  await waitFor(async () => (await latestMeeting()).warnings.includes('captions_off'), 'the captions-off warning');
  assert.notEqual((await latestMeeting()).captionsOn, true);
  await waitForText('Not taking notes yet');
  assert.ok(!(await panelText()).includes('Taking notes on this call'));

  // No captions and no audio: the user is told, loudly, everywhere
  const alert = await waitFor(
    async () => (await readTable('inbox')).find(item => item.id === `meetings|nothing:${meeting.id}`),
    'the alert',
    20000,
  );
  assert.equal(alert.kind, 'alert');
  assert.match(alert.title, /Nothing is being recorded/);
  assert.ok((await latestMeeting()).warnings.includes('nothing_captured'));
  const notifications = await panel.evaluate(() => chrome.notifications.getAll());
  assert.ok(Object.keys(notifications).includes(`meeting:nothing:${meeting.id}`));
  await waitForText('Nothing has been captured yet');
  await shot('meeting-autojoin-alert');

  // The toolbar click on the call is what lets Chrome hand over the audio: the same meeting records it
  await pressToolbarButton(extension, meet);
  await waitFor(async () => (await latestMeeting()).source === 'audio', 'the audio to be recorded');
  assert.equal((await latestMeeting()).id, meeting.id);
  assert.ok(!(await latestMeeting()).warnings.includes('nothing_captured'));
  assert.ok(!(await latestMeeting()).warnings.includes('captions_off'));
  await waitFor(
    async () => (await readTable('audioChunks')).some(chunk => chunk.meetingId === meeting.id),
    'audio chunks',
  );
  // The scripted model writes the audio down: words arrive in the same meeting
  await waitFor(
    async () => (await readTable('segments')).some(s => s.meetingId === meeting.id),
    'words from the audio',
  );
  await panel.bringToFront();
  await press('Open meeting');
  await waitForText('Recording ·');
  await click('Stop');
  await waitFor(async () => (await latestMeeting()).status === 'done', 'the meeting to finish', 40000);
  assert.equal((await readTable('meetings')).length, before + 1, 'one meeting, not two');
  await extension.setStorage({ 'meeting-settings': settings });
  await meet.close();
});

// Reads a table from an extension page of its own, so it works with the side panel closed
async function readTableFrom(page, name) {
  return page.evaluate(
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
}

test('leaving the call ends the notes and writes the summary, with the side panel closed', async () => {
  const before = (await readTable('meetings')).length;
  const meet = await joinMeetCall({ captions: true });
  const meeting = await waitFor(
    async () => (await readTable('meetings')).length > before && (await latestMeeting()),
    'notes to start on their own',
  );
  await waitFor(
    async () => (await readTable('segments')).filter(s => s.meetingId === meeting.id).length >= 2,
    'captions in the transcript',
  );

  // The panel goes away; an ordinary extension page reads the database from here on
  await panel.close();
  const reader = await extension.browser.newPage();
  await reader.goto(`${extension.origin}/options.html`);
  const notesBefore = mock.meeting.notes;
  const left = Date.now();
  await meet.bringToFront();
  await meet.evaluate(() => window.leaveCall());

  // The page says so at once: no waiting for three half-minute checks
  const done = await waitFor(
    async () => {
      const found = (await readTableFrom(reader, 'meetings')).find(m => m.id === meeting.id);
      return found?.status === 'done' && found;
    },
    'the notes to be written after leaving',
    40000,
  );
  assert.ok(Date.now() - left < 30000, `ended ${Math.round((Date.now() - left) / 1000)} s after leaving`);
  assert.ok(done.note, 'a summary was written');
  assert.ok(done.note.actionItems.length > 0, 'with action items');
  assert.ok(mock.meeting.notes > notesBefore);
  const messages = (await readTableFrom(reader, 'messages')).filter(m => m.threadId === done.threadId);
  assert.ok(
    messages.some(m => m.content.includes('Action items')),
    'the summary is in the meeting thread',
  );

  await reader.close();
  panel = await pressToolbarButton(extension, meet);
  await panel.waitForSelector('header');
  await meet.close();
});

test('a summary that fails says so loudly, and Retry writes it later', async () => {
  const web = await extension.browser.newPage();
  await web.goto(`${meetingUrl}?captions=1`);
  await web.bringToFront();
  await sleep(500);
  await panel.bringToFront();
  await press('Take meeting notes');
  await waitForText('from the meeting captions');
  const meeting = await latestMeeting();
  await waitFor(
    async () => (await readTable('segments')).some(s => s.meetingId === meeting.id),
    'captions in the transcript',
  );

  mock.meeting.failNotes = 1;
  await click('Stop');
  const failed = await waitFor(async () => {
    const found = await latestMeeting();
    return found.status === 'failed' && found;
  }, 'the note to fail');
  assert.ok(failed.warnings.includes('note_failed'));
  // Said where the user will see it: the Inbox, a notification that stays, and the panel
  const alert = await waitFor(
    async () => (await readTable('inbox')).find(item => item.id === `meetings|notes:${meeting.id}`),
    'the Inbox alert',
  );
  assert.equal(alert.kind, 'alert');
  const notifications = await panel.evaluate(() => chrome.notifications.getAll());
  assert.ok(Object.keys(notifications).includes(`meeting:notes:${meeting.id}`));
  await waitForText('Could not write the notes');
  await shot('meeting-note-failed');

  // Retry, later: the note is written, and the alert is done
  await click('Retry');
  await waitFor(async () => (await latestMeeting()).status === 'done', 'the retry to write the note');
  assert.ok((await latestMeeting()).note);
  assert.ok(!(await latestMeeting()).warnings.includes('note_failed'));
  await waitFor(
    async () => (await readTable('inbox')).find(item => item.id === alert.id)?.status === 'done',
    'the alert to be done',
  );
  await web.close();
});
