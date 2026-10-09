import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, sleep } from './harness.mjs';

/**
 * End-to-end test of "Hey Ava": a recording plays as the microphone, the on-device recogniser hears
 * the phrase with no side panel open, and a voice conversation starts with the words said after it.
 * Needs the recogniser's files: node scripts/wake-word-setup.mjs, then pnpm build.
 */

const recording = path.resolve(import.meta.dirname, 'hey-ava.wav');
const ready = fs.existsSync(path.resolve(import.meta.dirname, '../dist/wake/model.tar.gz'));
process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = recording;

let mock;
let extension;

before(async () => {
  if (!ready) return;
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
  });
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const waitFor = async (check, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

test('"Hey Ava" starts a conversation with the panel closed, only once listening is on', { skip: !ready }, async () => {
  const meetingSettings = {
    autoNotes: false,
    liveModel: 'gemini-3.8-live',
    liveEndpoint: `ws://127.0.0.1:${mock.port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
  };
  // A harmless tool for the mock to call once it hears the request
  mock.live.voiceTool = { name: 'get_status', args: {} };

  // Off by default: the recording plays, and nothing listens
  await extension.setStorage({ 'meeting-settings': { ...meetingSettings, wakeWord: false } });
  await sleep(8000);
  assert.equal(mock.live.sessions.filter(s => s.voice).length, 0, 'no conversation while listening is off');

  await extension.setStorage({ 'meeting-settings': { ...meetingSettings, wakeWord: true } });
  await waitFor(() => mock.live.sessions.some(s => s.voice), 'the conversation "Hey Ava" starts');
  const session = mock.live.sessions.find(s => s.voice);
  assert.ok(session.setups[0].tools, 'it is the voice conversation, with its tools');

  // The words said right after the phrase reach the copilot, ahead of the live microphone
  await waitFor(() => session.audioBytes > 0, 'audio in the conversation', 10000);
  await waitFor(() => mock.live.toolResponses.length > 0, 'the copilot to act on the request', 20000);
});
