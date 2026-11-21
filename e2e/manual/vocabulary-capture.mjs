// A short recording of the vocabulary in the panel: "Illum AI" is dictated and reads "Ellum AI". The panel page alone is
// recorded, never the whole screen. Usage: pnpm build && node e2e/manual/vocabulary-capture.mjs <out.mp4>
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, openSession, sleep } from '../harness.mjs';

process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, '../hey-ava.wav');
const out = process.argv[2] || 'vocabulary.mp4';

const mock = await startMockLlm({});
const extension = await launchExtension(mock);
const keys = await extension.getStorage('llm-api-keys');
keys.providers.gemini = {
  name: 'Gemini',
  type: 'gemini',
  apiKey: 'test',
  baseUrl: mock.baseUrl.replace(/\/v1$/, '/v1beta'),
  modelNames: ['gemini-3.8-flash'],
  createdAt: Date.now(),
};
await extension.setStorage({
  'llm-api-keys': keys,
  'speech-to-text-model': { speechToTextModel: { provider: 'gemini', modelName: 'gemini-3.8-flash' } },
});
await extension.browser.defaultBrowserContext().overridePermissions(extension.origin, ['microphone']);
const { panel } = await openSession(extension, mock);
await panel.setViewport({ width: 380, height: 800 });
await panel.bringToFront();

// The word is taught the way the Settings screen does it: one command to the background
await panel.evaluate(
  () =>
    new Promise(resolve => {
      const port = chrome.runtime.connect({ name: 'side-panel-connection' });
      port.onMessage.addListener(message => message.requestId === 'seed' && resolve(message));
      port.postMessage({ type: 'vocab_save', requestId: 'seed', write: 'Ellum', heardAs: ['Illum'], workspaceId: null });
    }),
);
await sleep(500);

async function dictate(words) {
  mock.dictation.text = words;
  await panel.click('button[aria-label="Start voice input"]');
  await panel.waitForSelector('.stt-strip[data-status="listening"]', { timeout: 15000 });
  await sleep(2200);
  await panel.click('button[aria-label="Stop: the words go in the box to edit"]');
  await panel.waitForFunction(() => (document.querySelector('textarea')?.value ?? '').length > 0, { timeout: 20000, polling: 300 });
}

const recorder = await panel.screencast({ path: out });
await sleep(1200);
await dictate('Illum AI is ready for the demo');
await sleep(3500);
await panel.evaluate(() => {
  const area = document.querySelector('textarea');
  area.focus();
  area.setSelectionRange(2, 2);
  area.click();
});
await sleep(3000);
await panel.evaluate(() => {
  const input = document.querySelector('textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(600);
await dictate('The ilium is part of the pelvis');
await sleep(4000);
await recorder.stop();
await extension.close();
await mock.close();
