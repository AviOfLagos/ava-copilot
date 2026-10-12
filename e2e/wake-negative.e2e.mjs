import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, sleep } from './harness.mjs';

/**
 * End-to-end test of "Hey Ava"'s precision: "hey" that is not followed by "Ava" ("Hey.", "Hey there,
 * how are you?", "Hey everyone, have a look at this.", "Okay, hey.") must never start a voice conversation (see e2e/wake.e2e.mjs for the positive case: "Hey Ava" itself
 * still has to work). Needs the recogniser's files: node scripts/wake-word-setup.mjs, then
 * pnpm build. Uses its own browser instance because the fake microphone's recording is fixed for
 * the life of the browser process (Chrome's --use-file-for-fake-audio-capture).
 */

const recording = path.resolve(import.meta.dirname, 'fixtures/wake/hey-not-ava.wav');
const ready = fs.existsSync(path.resolve(import.meta.dirname, '../dist/wake/model.tar.gz'));
process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = recording;

let mock;
let extension;

before(async () => {
  if (!ready) return;
  mock = await startMockLlm({});
  extension = await launchExtension(mock);
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

test('"hey" without "Ava", said on a loop, never starts a conversation', { skip: !ready }, async () => {
  await extension.setStorage({
    'meeting-settings': {
      autoNotes: false,
      wakeWord: true,
      liveModel: 'gemini-3.8-live',
      liveEndpoint: `ws://127.0.0.1:${mock.port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
    },
  });
  // The recording loops continuously; plenty of time for the bug ("hey" alone used to wake it) to
  // show up if the verification stage were not rejecting the candidate it still, correctly, finds.
  // Two passes of the recording (9.5 s each)
  await sleep(20000);
  assert.equal(mock.live.sessions.filter(s => s.voice).length, 0, 'no conversation started without "Ava"');
});
