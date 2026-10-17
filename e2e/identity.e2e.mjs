import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of Ava's identity and voice as the hub: the voice setup carries the fixed voice, the language rule
 * and the identity; read_screen gives the page and sends a picture; the owner's spoken request drafts the
 * meeting-links routine, which then offers to join when a Meet link opens; remember adds a fact that Settings ›
 * About you shows; the chat agent gets the identity too.
 */

process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');
const SHOTS = process.env.E2E_SHOTS;

const done = () => [{ done: { text: 'Done.', success: true } }];
const scenarios = { 'identity-chat': [done] };

let mock;
let extension;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
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
    // These run on Gemini Live (the mock's): picked, since a conversation is on the device by default
    'voice-engine-settings': { mode: 'live', modeChosen: true },
    'meeting-settings': {
      liveModel: 'gemini-3.8-live',
      autoNotes: true,
      liveEndpoint: `ws://127.0.0.1:${mock.port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
    },
    'voice-identity': { liveVoice: 'Kore', language: 'pt-BR' },
  });
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const waitFor = async (check, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const shot = async (page, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const readTable = (page, name) =>
  page.evaluate(
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

/** One spoken turn that calls `tool`: returns the tool's answer and the session the mock saw. */
async function speakTool(heard, tool, { keep = false } = {}) {
  mock.live.voiceRequest = heard;
  mock.live.voiceTool = tool;
  const before = mock.live.toolResponses.length;
  const session = await openSession(extension, mock);
  await session.web.bringToFront();
  await session.click('Talk to Ava');
  await waitFor(() => mock.live.toolResponses.length > before, 'the tool response');
  const response = JSON.stringify(mock.live.toolResponses[before].response);
  const voiceSession = mock.live.sessions.filter(s => s.voice).pop();
  mock.live.voiceTool = undefined;
  if (!keep) {
    await session.click('Stop talking');
    await session.close();
  }
  return { response, voiceSession, session };
}

test('the voice setup carries the fixed voice, the language rule and who Ava is', async () => {
  await extension.setStorage({
    'about-you': {
      facts: [
        {
          id: 'fact-seed',
          text: 'Runs Nexprove with two co-founders',
          category: 'company',
          workspaceId: null,
          source: 'settings',
          status: 'active',
          via: 'settings',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          previous: [],
        },
      ],
      goals: [],
      insights: [],
      lastReflectionAt: null,
    },
  });
  const { voiceSession } = await speakTool('What is going on?', { name: 'get_status', args: {} });
  const setup = voiceSession.setups[0];
  assert.deepEqual(setup.generationConfig.speechConfig, {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
  });
  const instructions = setup.systemInstruction.parts[0].text;
  assert.match(instructions, /always speak Português \(Brasil\) \(pt-BR\)/);
  assert.match(instructions, /It's Ava, but I'm listening/);
  assert.match(instructions, /Never say you cannot see the screen/);
  assert.match(instructions, /Runs Nexprove with two co-founders/);
  assert.match(instructions, /Hi, how can I help you today\?/, 'the banned opener is named');
  // Below the rules
  assert.ok(instructions.indexOf('Who you are') > instructions.indexOf('You cannot confirm for them'));

  // A model that takes the language gets languageCode too
  const settings = await extension.getStorage('meeting-settings');
  await extension.setStorage({ 'meeting-settings': { ...settings, liveModel: 'gemini-live-2.5-flash-preview' } });
  const cascade = await speakTool('What is going on?', { name: 'get_status', args: {} });
  assert.deepEqual(cascade.voiceSession.setups[0].generationConfig.speechConfig, {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
    languageCode: 'pt-BR',
  });
  await extension.setStorage({ 'meeting-settings': settings });
});

test('read_screen gives the page in front and shows Ava a picture of it', async () => {
  const framesBefore = mock.live.frames.length;
  const { response } = await speakTool('Check my screen, what is this about?', { name: 'read_screen', args: {} });
  assert.match(response, /Gate fixture/);
  assert.match(response, /A picture of the screen was sent to you/);
  assert.doesNotMatch(response, /cannot see/i);
  await waitFor(() => mock.live.frames.length > framesBefore, 'the screen frame');
  const frame = mock.live.frames.at(-1);
  assert.equal(frame.mimeType, 'image/jpeg');
  assert.ok(frame.bytes > 1000, 'a real picture');
});

const OWNER_REQUEST =
  "I want us to set a hook that would always capture when there's a Zoom link in the browser, when there is a calendar link or a Google Meet link in the browser. And take action accordingly.";

const MEET_LOBBY = `<!doctype html><title>Meet</title><body><h1>Ready to join?</h1><script>
  window.clicks = [];
  const join = document.createElement('button');
  join.textContent = 'Join now';
  join.onclick = () => window.clicks.push('Join now');
  document.body.appendChild(join);
</script></body>`;

test('the owner’s spoken request drafts the meeting-links routine, which offers to join when a Meet link opens', async () => {
  const { response, session } = await speakTool(OWNER_REQUEST, {
    name: 'create_workflow',
    args: { request: OWNER_REQUEST },
  });
  assert.match(response, /Drafted \\"Meeting links\\"/);
  assert.match(response, /only a draft/);
  const page = await extension.browser.newPage();
  await page.goto(`${extension.origin}/workflows.html`);
  const [workflow] = (await readTable(page, 'workflows')).filter(item => item.name === 'Meeting links');
  assert.ok(workflow, 'a draft was saved');
  assert.equal(workflow.status, 'draft');
  const patterns = workflow.draft.spec.nodes.filter(node => node.type === 'trigger.tab').map(node => node.urlPattern);
  assert.ok(patterns.includes('zoom.us/j/*') && patterns.includes('meet.google.com/*-*-*'));
  assert.ok(patterns.some(pattern => pattern.startsWith('calendar.google.com')));

  // Nothing runs before the user's click on Create
  const confirmed = await page.evaluate(
    id => chrome.runtime.sendMessage({ type: 'workflow_confirm', id }),
    workflow.id,
  );
  assert.equal(confirmed.type, 'workflow_ok');

  // A Meet link opens: the routine starts, and joining waits for the user's click
  const meet = await extension.browser.newPage();
  await meet.setRequestInterception(true);
  meet.on('request', request =>
    request.url().startsWith('https://meet.google.com/')
      ? request.respond({ status: 200, contentType: 'text/html', body: MEET_LOBBY })
      : request.continue(),
  );
  await meet.goto('https://meet.google.com/abc-defg-hij');
  let run;
  await waitFor(async () => {
    run = (await readTable(page, 'runs')).find(item => item.workflowId === workflow.id);
    return run?.status === 'waiting_user';
  }, 'the run to wait for the click');
  assert.equal(run.trigger.type, 'tab');
  const approval = (await readTable(page, 'inbox')).find(item => item.kind === 'approval');
  assert.match(approval.title, /Meeting links/);
  assert.deepEqual(await meet.evaluate(() => window.clicks), [], 'nothing clicked before the OK');

  // The user's OK: Join is pressed on the page
  const answered = await page.evaluate(
    runId => chrome.runtime.sendMessage({ type: 'workflow_step_answer', runId, nodeId: 'join', approved: true }),
    run.id,
  );
  assert.equal(answered.type, 'workflow_ok');
  await waitFor(async () => (await meet.evaluate(() => window.clicks)).includes('Join now'), 'the join click', 30000);
  await waitFor(
    async () => (await readTable(page, 'runs')).find(item => item.id === run.id)?.status === 'succeeded',
    'the run to finish',
  );
  // Reloading the same link does not ask again
  await meet.reload();
  await sleep(1500);
  assert.equal((await readTable(page, 'runs')).filter(item => item.workflowId === workflow.id).length, 1);
  await meet.close();
  await page.close();
  await session.close().catch(() => {});
});

test('remember keeps what the user said, and Settings › About you shows it', async () => {
  const { response } = await speakTool('Remember that I am head of product at Ellum', {
    name: 'remember',
    args: { fact: 'Head of product at Ellum', category: 'role' },
  });
  assert.match(response, /Remembered/);
  // Something the user never said is only proposed
  const proposed = await speakTool('What do you think of this page?', {
    name: 'remember',
    args: { fact: 'Owns a yacht in Monaco', category: 'other' },
  });
  assert.match(proposed.response, /suggestion only/);
  const about = await extension.getStorage('about-you');
  assert.equal(about.facts.find(fact => fact.text === 'Head of product at Ellum')?.status, 'active');
  assert.equal(about.facts.find(fact => fact.text === 'Owns a yacht in Monaco')?.status, 'proposed');

  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 760 });
  await session.panel.bringToFront();
  await session.panel.evaluate(() => {
    const el = document.querySelector('[data-testid="personality-picker"]');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await session.panel.waitForSelector('[role="menuitem"]', { timeout: 5000 });
  await session.panel.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"]')]
      .find(el => el.innerText.includes('Manage personalities'))
      .click(),
  );
  await session.panel.waitForSelector('[aria-label="About you"]', { timeout: 10000 });
  const text = await session.panel.evaluate(() => document.querySelector('[aria-label="About you"]').innerText);
  assert.match(text, /Head of product at Ellum/);
  assert.match(text, /Owns a yacht in Monaco/);
  assert.match(text, /Waiting for your OK/);

  // Confirming the proposed one makes it active
  await session.click('Confirm “Owns a yacht in Monaco”');
  await waitFor(
    async () =>
      (await extension.getStorage('about-you')).facts.find(fact => fact.text === 'Owns a yacht in Monaco')?.status ===
      'active',
    'the confirmation',
  );
  await session.panel.evaluate(() =>
    document.querySelector('[aria-label="About you"]').scrollIntoView({ block: 'start' }),
  );
  await sleep(400);
  await shot(session.panel, 'about-you');
  await session.panel.evaluate(() =>
    document.querySelector('[aria-label="Personalities"]').scrollIntoView({ block: 'start' }),
  );
  await sleep(300);
  await shot(session.panel, 'ava-core');
  await session.panel.evaluate(() =>
    document.querySelector('[aria-label="Voice and language"]').scrollIntoView({ block: 'start' }),
  );
  await sleep(300);
  await shot(session.panel, 'voice-language');
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test('the chat agent knows who it is and what it knows about the user', async () => {
  const session = await openSession(extension, mock);
  mock.start('identity-chat');
  await session.send('Run the scripted scenario identity-chat');
  await session.waitForEnd();
  const [first] = mock.runs.get('identity-chat').requests;
  assert.match(first, /# WHO YOU ARE/);
  assert.match(first, /Head of product at Ellum/);
  assert.match(first, /It's Ava, but I'm listening/);
  assert.ok(first.indexOf('# WHO YOU ARE') > first.indexOf('# COMMIT ACTIONS'), 'after the gate rules');
  await session.close();
});
