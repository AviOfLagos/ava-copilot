// A short recording of the typing box, from the panel page alone (never the whole screen).
// Usage: pnpm build && node e2e/manual/typing-box-capture.mjs <out.mp4>   (needs ffmpeg)
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, openSession, sleep } from '../harness.mjs';

process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, '../hey-ava.wav');
const out = process.argv[2] || 'typing-box.mp4';

const mock = await startMockLlm({});
const extension = await launchExtension(mock);
await extension.browser.defaultBrowserContext().overridePermissions(extension.origin, ['microphone']);
const { panel } = await openSession(extension, mock);
await panel.setViewport({ width: 380, height: 800 });
await panel.bringToFront();
await sleep(500);

const recorder = await panel.screencast({ path: out });
await sleep(1200);
await panel.focus('textarea');
await panel.keyboard.type('Remind me to chase Ada about the north office figures,', { delay: 25 });
await panel.keyboard.down('Shift');
await panel.keyboard.press('Enter');
await panel.keyboard.up('Shift');
for (const line of ['and ask Sam for the new rota,', 'then send Kemi the agenda,', 'and book the review for Friday.']) {
  await panel.keyboard.type(line, { delay: 20 });
  await panel.keyboard.down('Shift');
  await panel.keyboard.press('Enter');
  await panel.keyboard.up('Shift');
}
await panel.keyboard.type('Thanks.', { delay: 20 });
await sleep(1500);
await panel.click('button[aria-label="Expand the text box"]');
await sleep(2000);
await panel.keyboard.press('Escape');
await sleep(1500);
const long = Array.from({ length: 30 }, (_, i) => `Point ${i + 1}: check the figures and tell me what changed.`).join(' ');
await panel.evaluate(text => {
  const input = document.querySelector('textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, long);
await sleep(2000);
await panel.click('button[aria-label="Start voice input"]');
await sleep(3500);
await panel.keyboard.press('Escape');
await sleep(1500);
await recorder.stop();
await extension.close();
await mock.close();
