import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of Ava as the master interface: what_can_you_do lists every tool and the panel's places,
 * switching tabs reaches the conversation at once as quiet context (no confirmation), check_audio measures the fake
 * microphone, and open_place opens a Settings section in the panel.
 */

process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');

let mock;
let extension;

before(async () => {
  mock = await startMockLlm({});
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

/** One spoken turn that calls `tool`: the tool's answer, and the session to go on with or close. */
async function speakTool(heard, tool) {
  mock.live.voiceRequest = heard;
  mock.live.voiceTool = tool;
  const before = mock.live.toolResponses.length;
  const session = await openSession(extension, mock);
  await session.web.bringToFront();
  await session.click('Talk to Ava');
  await waitFor(() => mock.live.toolResponses.length > before, 'the tool response');
  mock.live.voiceTool = undefined;
  const response = JSON.parse(JSON.stringify(mock.live.toolResponses[before].response)).result ?? '';
  return { response: String(response), session };
}

async function end(session) {
  await session.click('Stop talking').catch(() => {});
  await sleep(300);
  await session.close();
}

/** Runs `check` on a spoken turn's tool answer, and always ends the conversation after. */
async function withTool(heard, tool, check) {
  const { response, session } = await speakTool(heard, tool);
  try {
    await check(response, session);
  } finally {
    await end(session);
  }
}

test('what_can_you_do lists every tool, grouped, and the panel’s places and settings', async () => {
  await withTool('What can you do?', { name: 'what_can_you_do', args: {} }, async response => {
    for (const name of ['read_screen', 'check_audio', 'check_model', 'open_place', 'run_workflow', 'set_personality']) {
      assert.match(response, new RegExp(`- ${name}:`), name);
    }
    assert.match(response, /Your screen and tabs:/);
    assert.match(response, /In a chat \(the browser agent/);
    // From the panel's own registrations, as it reported them
    assert.match(response, /Places in the side panel I can open:[\s\S]*Inbox/);
    assert.match(response, /Settings sections I can open:[\s\S]*Audio devices/);
    // The voice setup carries the short list too
    const setup = mock.live.sessions.filter(s => s.voice).pop().setups[0];
    assert.match(setup.systemInstruction.parts[0].text, /What you can do \(your tools by group/);
    assert.match(setup.systemInstruction.parts[0].text, /The user's tab in front: "Gate fixture"/);
  });
});

test('switching tabs reaches the conversation at once, with the tab before it, and no confirmation', async () => {
  await withTool('What is going on?', { name: 'get_status', args: {} }, async (_response, session) => {
    const before = mock.live.context.length;
    const other = await extension.browser.newPage();
    await other.goto(`${mock.fixtureUrl}?other`);
    await other.evaluate(() => (document.title = 'Quarterly numbers'));
    await other.bringToFront();
    await waitFor(
      () => mock.live.context.slice(before).some(c => c.text.includes('"Quarterly numbers"')),
      'the tab switch as quiet context',
    );
    const line = mock.live.context
      .slice(before)
      .map(c => c.text)
      .findLast(text => text.includes('"Quarterly numbers"'));
    assert.match(
      line,
      /^System context \(no reply needed\): The user's tab in front: "Quarterly numbers" \(127\.0\.0\.1\)/,
    );
    assert.match(line, /\(previous: "Gate fixture"/);
    // Back to the first tab: the conversation hears that too
    await session.web.bringToFront();
    await waitFor(
      () =>
        mock.live.context
          .slice(before)
          .some(c => /tab in front: "Gate fixture".*previous: "Quarterly numbers"/.test(c.text)),
      'the switch back',
    );
    // Nothing asked the user to click
    assert.doesNotMatch(await session.panelText(), /wants to/);
    // The chat agent's prompt gets the same line (through the capability list command)
    const listed = await session.panel.evaluate(
      () =>
        new Promise(resolve => {
          const port = chrome.runtime.connect({ name: 'side-panel-connection' });
          port.onMessage.addListener(message => {
            if (message.requestId === 'cap-1') resolve(message);
          });
          port.postMessage({ type: 'capabilities_list', requestId: 'cap-1' });
        }),
    );
    assert.match(listed.tab, /tab in front: "Gate fixture"/);
    assert.ok(new Set(listed.names).size === listed.names.length, 'no tool listed twice');
    await other.close();
  });
});

test('check_audio names the devices, hears the fake microphone, and plays a test tone', async () => {
  await withTool('Can you hear me? Check my mic.', { name: 'check_audio', args: {} }, async response => {
    assert.match(
      response,
      /Microphone: System default \(opened: Fake Default Audio Input\)\. Speaker: System default\./,
    );
    assert.match(response, /I can hear you: the mic level went up to \d+ of 100|The mic hears only a little/);
    assert.match(response, /A short test tone just played/);
  });
});

test('open_place opens a Settings section in the panel and says so', async () => {
  const tool = { name: 'open_place', args: { place: 'audio devices' } };
  await withTool('Open my audio devices settings', tool, async (response, session) => {
    assert.match(response, /Opened Settings › Audio devices in the side panel/);
    // Settings is open, scrolled to the section, with focus on it
    await waitFor(
      () => session.panel.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Audio devices'),
      'the section in view',
    );
  });
});
