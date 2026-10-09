import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, readThreads, sleep } from './harness.mjs';

/**
 * End-to-end test of the voice conversation: a fake microphone, the mock's Live API in voice mode,
 * a browser task started by voice, and the spoken notices that follow it.
 */

process.env.E2E_FAKE_MIC = '1';

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
      'ask_meeting',
      'ask_knowledge',
      'get_status',
      'stop_tasks',
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
