import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of voices you can tell apart: a personality's Live voice is the session's voice, switching
 * personality mid-conversation starts the session again in the new voice (keeping the conversation), an agent's
 * answer is said in the agent's own voice with its name first, and the editors pick a voice per engine.
 */

process.env.E2E_FAKE_MIC = '1';
// Speech as the microphone: silence never reaches the model
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');
// Screenshots for review go here when E2E_SHOTS is set
const SHOTS = process.env.E2E_SHOTS;

const done = () => [{ done: { text: 'Two sources on the quote form.', success: true } }];
const scenarios = { 'agent-voice-run': [done] };

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

const waitFor = async (check, label, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const shot = async (page, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const voiceSessions = () => mock.live.sessions.filter(s => s.voice && s.setups.length);
const voiceNameOf = setup => setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;

/** A panel command with a reply, the way the panel's PanelApi sends one. */
function command(page, message, timeout = 30_000) {
  return page.evaluate(
    (message, timeout) =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'side-panel-connection' });
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => reject(new Error(`${message.type} timed out`)), timeout);
        port.onMessage.addListener(reply => {
          if (reply.requestId !== requestId) return;
          clearTimeout(timer);
          port.disconnect();
          if (reply.type === 'error') reject(new Error(reply.error));
          else resolve(reply);
        });
        port.postMessage({ ...message, requestId });
      }),
    message,
    timeout,
  );
}

function readStore(page, store) {
  return page.evaluate(
    store =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction(store).objectStore(store).getAll();
          all.onsuccess = () => {
            resolve(all.result);
            open.result.close();
          };
          all.onerror = () => reject(all.error);
        };
      }),
    store,
  );
}

test("a personality's Live voice, and a switch mid-conversation restarts the session in the new voice", async () => {
  await extension.setStorage({ personalities: { custom: [], activeId: 'engineer', workspaceDefaults: {} } });
  const before = voiceSessions().length;
  mock.live.voiceRequest = 'Switch to the accountant';
  mock.live.voiceTool = { name: 'set_personality', args: { name: 'accountant' } };
  const session = await openSession(extension, mock);
  await session.web.bringToFront();
  await session.click('Talk to Ava');

  await waitFor(() => voiceSessions().length > before, 'the voice session');
  const first = voiceSessions()[before];
  assert.equal(voiceNameOf(first.setups[0]), 'Puck', "the engineer's Live voice");

  // The switch: the tool answer says the session reconnects, and a new session opens in the accountant's voice
  await waitFor(() => mock.live.toolResponses.some(r => r.name === 'set_personality'), 'the switch');
  const answer = JSON.stringify(mock.live.toolResponses.find(r => r.name === 'set_personality').response);
  assert.match(answer, /reconnects in a moment in the new voice/);
  mock.live.voiceTool = { name: 'get_status', args: {} };
  const second = await waitFor(
    () =>
      voiceSessions()
        .slice(before + 1)
        .find(s => voiceNameOf(s.setups[0]) === 'Charon'),
    'the session in the new voice',
  );
  assert.ok(first.closed, 'the old session closed');
  // A fresh session (a resumed one keeps its old voice), with the conversation so far and the new personality
  assert.deepEqual(second.setups[0].sessionResumption, {});
  const instructions = second.setups[0].systemInstruction.parts[0].text;
  assert.match(instructions, /Personality: Accountant/);
  // It greets the user in the new voice first
  await waitFor(
    () => mock.live.notices.some(n => n.includes('You switched to the personality "Accountant"')),
    'the greeting',
  );
  // The language is still the Settings one, the thread the same
  const threads = await readStore(session.panel, 'threads');
  assert.equal(threads.filter(t => t.tags?.includes('voice')).length, 1, 'one conversation thread');

  await session.click('Stop talking');
  mock.live.voiceTool = undefined;
  await session.close();
  await extension.setStorage({ personalities: { custom: [], activeId: 'default', workspaceDefaults: {} } });
});

test("an agent's answer is said in the agent's own voice, its name first", async () => {
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 900 });
  await session.panel.bringToFront();
  // The starter team's Research agent (personality: the engineer), created from its template
  await session.click('Menu');
  await session.click('Agents');
  await session.panel.waitForSelector('[data-team-setup]', { timeout: 10000 });
  await session.panel.evaluate(() => document.querySelector('[data-team-setup]').click());
  await session.panel.waitForSelector('[data-team-template="team_research"]', { timeout: 10000 });
  await session.panel.evaluate(() => document.querySelector('[data-team-template="team_research"]').click());
  await session.panel.evaluate(() => document.querySelector('[data-team-create]').click());
  const draft = await waitFor(
    async () => (await readStore(session.panel, 'agents')).find(a => a.name === 'Research'),
    'the draft',
  );
  assert.equal(draft.personalityId, 'engineer');
  await session.panel.waitForSelector('[data-agent="Research"]', { timeout: 10000 });
  await session.panel.evaluate(() => document.querySelector('[data-agent="Research"]').click());
  await session.panel.waitForSelector('[data-agent-draft]', { timeout: 10000 });
  await session.click('Create');
  await waitFor(
    async () => (await readStore(session.panel, 'agents')).find(a => a.id === draft.id)?.status === 'active',
    'the agent created',
  );

  // Its editor: a personality and a voice per engine, each with Preview
  await session.click('Edit agent');
  await session.panel.waitForSelector('[data-voice-picker] [data-voice-slot="kitten"]', { timeout: 10000 });
  const options = await session.panel.evaluate(
    () => document.querySelector('[data-voice-picker] [data-voice-slot="kitten"] option').textContent,
  );
  assert.match(options, /From its personality \(Leo\)/);
  await session.panel.evaluate(() =>
    document.getElementById('agent-edit-personality').scrollIntoView({ block: 'center' }),
  );
  await sleep(300);
  await shot(session.panel, 'agent-editor-voices');
  await session.click('Cancel');

  // Asked by voice: the run starts, and its answer comes back in its own voice
  mock.start('agent-voice-run');
  mock.live.voiceRequest = 'Run my research agent';
  mock.live.voiceTool = { name: 'run_agent', args: { name: 'Research' } };
  await session.web.bringToFront();
  await session.click('Talk to Ava');
  const line = await waitFor(
    async () => {
      const { runtime } = await command(session.panel, { type: 'voice_engine_status' });
      return runtime?.lastLine?.text?.startsWith('Research:') ? runtime.lastLine : null;
    },
    "the agent's line",
    90000,
  );
  // The run's answer (the scripted model ends every run with this line)
  assert.match(line.text, /^Research: E2E scenario finished\./);
  // The Live session cannot change voice: the line plays on the device in the engineer's Kitten voice
  assert.deepEqual([line.engine, line.voice], ['kitten', 'Leo']);
  // Live is told it was said (as data), and Ava did not announce it herself
  await waitFor(() => mock.live.context.some(c => /in another voice/.test(c.text)), 'Live told what was said');
  assert.ok(!mock.live.notices.some(n => /Research .* is done/.test(n)), "not announced in Ava's voice too");
  const runAnswer = JSON.stringify(mock.live.toolResponses.find(r => r.name === 'run_agent').response);
  assert.match(runAnswer, /tells the user its answer itself, in its own voice/);

  await session.click('Stop talking');
  mock.live.voiceTool = undefined;
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test('a built-in personality takes voices of its own from the editor', async () => {
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 900 });
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
  // Manage opens the full-page Settings at Personalities
  const settings = await extension.settingsTab('#personalities');
  await settings.waitForSelector('[aria-label="Voices of Cracked engineer"]', { timeout: 10000 });
  await extension.clickOn(settings, 'Voices of Cracked engineer');
  await settings.waitForSelector('[data-voice-picker="persona"] [data-voice-slot="live"]', { timeout: 5000 });
  const shown = await settings.evaluate(() => document.querySelector('[data-voice-slot="live"]').value);
  assert.equal(shown, 'Puck', 'its own Live voice is shown');
  await settings.select('[data-voice-slot="live"]', 'Fenrir');
  await settings.evaluate(() =>
    document.querySelector('[data-voice-picker="persona"]').closest('form').scrollIntoView({ block: 'start' }),
  );
  await sleep(300);
  await shot(settings, 'personality-voices');
  await extension.clickOn(settings, 'Save');
  await waitFor(async () => (await extension.getStorage('personalities'))?.voiceOverrides?.engineer, 'saved');
  const stored = await extension.getStorage('personalities');
  assert.equal(stored.voiceOverrides.engineer.voices.live, 'Fenrir');
  assert.equal(stored.voiceOverrides.engineer.voices.kitten, 'Leo', 'the other engines keep theirs');
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});
