import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, readThreads, sleep } from './harness.mjs';

/**
 * End-to-end test of the voice conversation: a fake microphone, the mock's Live API in voice mode,
 * a browser task started by voice, and the spoken notices that follow it.
 */

process.env.E2E_FAKE_MIC = '1';
// Speech as the microphone: silence never reaches the model, so the fake device's quiet beep would send nothing
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const scenarios = {
  'voice-task': [done],
  'voice-send': [
    page => [{ input_text: { intent: 'Write', index: page.find('div', 'role=textbox'), text: 'Voice hello' } }],
    page => [{ click_element: { intent: 'Send it', index: page.find('div', 'Send message') } }],
    done,
  ],
};

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
    'meeting-settings': {
      liveModel: 'gemini-3.8-live',
      autoNotes: false,
      liveEndpoint: `ws://127.0.0.1:${mock.port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
    },
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

test('a spoken request runs a browser task, and the copilot says when it is done', async () => {
  mock.start('voice-task');
  mock.live.voiceRequest = 'Run the scripted scenario voice-task.';
  const session = await openSession(extension, mock);
  await session.web.bringToFront();
  await session.click('Talk to the copilot');

  // The session is set up as a conversation with tools, and hears the microphone
  await waitFor(() => mock.live.sessions.some(s => s.voice), 'a voice session');
  const voiceSession = mock.live.sessions.find(s => s.voice);
  assert.deepEqual(voiceSession.setups[0].generationConfig, { responseModalities: ['AUDIO'] });
  assert.deepEqual(
    voiceSession.setups[0].tools[0].functionDeclarations.map(f => f.name),
    [
      'run_browser_task',
      'list_tabs',
      'read_page',
      'open_tab',
      'switch_tab',
      'get_brief',
      'get_schedule',
      'join_next_meeting',
      'leave_call',
      'end_call_for_everyone',
      'list_frequent_sites',
      'remember_this',
      'think',
      'ask_meeting',
      'ask_knowledge',
      'get_status',
      'stop_tasks',
      // Registered by features (routines, agents, the Inbox, voice engines), in registration order
      'run_workflow',
      'list_workflows',
      'list_agents',
      'run_agent',
      'read_inbox',
      'end_conversation',
    ],
  );
  assert.match(voiceSession.setups[0].systemInstruction.parts[0].text, /You cannot confirm for them/);

  // The tool ran the task in the browser and answered the model
  await waitFor(() => mock.live.toolResponses.length > 0, 'the tool response');
  assert.match(JSON.stringify(mock.live.toolResponses[0].response), /Started in the browser/);
  await waitFor(
    async () => (await readThreads(session.panel)).some(t => t.title.includes('voice-task') && t.status === 'idle'),
    'the task to finish',
  );

  // Proactive: the copilot is told to say the task is done
  await waitFor(
    () => mock.live.notices.some(n => n.includes('voice-task') && n.includes('is done')),
    'the done notice',
  );

  // The conversation is kept in its own thread
  const voiceThread = (await readThreads(session.panel)).find(t => t.tags.includes('voice'));
  assert.ok(voiceThread);
  await session.click('Stop talking');
  await session.close();
});

test('a send started by voice waits for the click, and the copilot says so', async () => {
  mock.start('voice-send');
  mock.live.voiceRequest = 'Run the scripted scenario voice-send.';
  const noticesBefore = mock.live.notices.length;
  const session = await openSession(extension, mock);
  await session.web.bringToFront();
  await session.click('Talk to the copilot');

  await session.waitForCard(30000);
  await waitFor(
    () => mock.live.notices.slice(noticesBefore).some(n => n.includes('waits for their click on Confirm')),
    'the confirm notice',
  );
  // Nothing was sent: only the click sends
  assert.deepEqual(await session.events(), []);
  await session.answer('Confirm');
  await waitFor(async () => (await session.events()).length === 1, 'the send after the click');
  await session.click('Stop talking');
  await session.close();
});

// A Google Meet call as far as hanging up goes: Leave, the host's choice to just leave, and the
// options menu with "End the call for everyone" and its confirm. Every click is logged.
const MEET_CALL = `<!doctype html><title>Meet</title><body><script>
  window.clicks = [];
  const add = (parent, label, role, onClick, aria) => {
    const element = document.createElement('button');
    if (role) element.setAttribute('role', role);
    if (aria) element.setAttribute('aria-label', label); else element.textContent = label;
    element.onclick = () => { window.clicks.push(label); onClick?.(); };
    parent.appendChild(element);
  };
  const dialog = () => {
    const box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    document.body.appendChild(box);
    return box;
  };
  add(document.body, 'Leave call', null, () => {
    const box = dialog();
    add(box, 'Just leave the call');
    add(box, 'End the call for everyone');
  }, true);
  add(document.body, 'End call options', null, () => {
    const menu = document.createElement('ul');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    add(menu, 'End the call for everyone', 'menuitem', () => {
      const box = dialog();
      add(box, 'Cancel');
      add(box, 'End call');
    });
  }, true);
</script></body>`;

async function openMeetCall() {
  const meet = await extension.browser.newPage();
  await meet.setRequestInterception(true);
  meet.on('request', request =>
    request.url().startsWith('https://meet.google.com/')
      ? request.respond({ status: 200, contentType: 'text/html', body: MEET_CALL })
      : request.continue(),
  );
  await meet.goto('https://meet.google.com/abc-defg-hij');
  return meet;
}

async function speakTool(heard, tool) {
  mock.live.voiceRequest = heard;
  mock.live.voiceTool = tool;
  const before = mock.live.toolResponses.length;
  const session = await openSession(extension, mock);
  await session.web.bringToFront();
  await session.click('Talk to the copilot');
  await waitFor(() => mock.live.toolResponses.length > before, 'the tool response');
  const response = JSON.stringify(mock.live.toolResponses[before].response);
  await session.click('Stop talking');
  await session.close();
  mock.live.voiceTool = undefined;
  return response;
}

test('"leave the call" leaves quietly and never ends it for the others', async () => {
  const meet = await openMeetCall();
  const response = await speakTool('Leave the call', { name: 'leave_call', args: {} });
  assert.match(response, /Left the call/);
  assert.deepEqual(await meet.evaluate(() => window.clicks), ['Leave call', 'Just leave the call']);
  await meet.close();
});

test('"end the call" ends it for everyone, but only on the user\'s own words', async () => {
  const meet = await openMeetCall();
  const refused = await speakTool('What did they say?', { name: 'end_call_for_everyone', args: {} });
  assert.match(refused, /did not say to end the call/);
  assert.deepEqual(await meet.evaluate(() => window.clicks), []);

  const response = await speakTool('End the call', { name: 'end_call_for_everyone', args: {} });
  assert.match(response, /Ended the call for everyone/);
  assert.deepEqual(await meet.evaluate(() => window.clicks), [
    'End call options',
    'End the call for everyone',
    'End call',
  ]);
  await meet.close();
});

test('ending the conversation while it connects closes it for good', async () => {
  const before = mock.live.sessions.filter(s => s.voice).length;
  const session = await openSession(extension, mock);
  await session.web.bringToFront();
  await session.click('Talk to the copilot');
  await session.panel.waitForSelector('[aria-label="End the conversation"]', { timeout: 10000 });
  await session.click('End the conversation');

  // Whatever was still on its way, the screen stays closed and the session ends
  await sleep(5000);
  assert.equal(await session.panel.$('[aria-label="End the conversation"]'), null, 'the voice screen stayed closed');
  assert.ok(await session.panel.$('[aria-label="Talk to the copilot"]'), 'the talk button is back');
  const opened = mock.live.sessions.filter(s => s.voice).slice(before);
  assert.ok(
    opened.every(s => s.closed),
    'no conversation is left open',
  );
  await session.close();
});
