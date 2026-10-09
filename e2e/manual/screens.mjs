// Takes screenshots of the panel's main screens against the scripted model, for looking at the design.
// Run: node e2e/manual/screens.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, openSession, sleep } from '../harness.mjs';

const out = process.argv[2] ?? 'screens';
fs.mkdirSync(out, { recursive: true });

const writeMessage = text => page => [
  { input_text: { intent: 'Write the message', index: page.find('div', 'role=textbox'), text } },
];
const clickSend = page => [{ click_element: { intent: 'Send it', index: page.find('div', 'Send message') } }];
const slowly = (ms, step) => async page => {
  await sleep(ms);
  return step(page);
};

const mock = await startMockLlm({
  'screens-send': [
    writeMessage('Stage 2 now closes Friday 10 October.'),
    clickSend,
    () => [{ done: { text: 'Posted.', success: true } }],
  ],
  'screens-run': [writeMessage('Draft'), slowly(60000, () => [{ done: { text: 'ok', success: true } }])],
});
const extension = await launchExtension(mock);

const shot = async (page, name) => {
  await page.setViewport({ width: 400, height: 860 });
  await sleep(900);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('saved', name);
};

const session = await openSession(extension, mock);
await shot(session.panel, '1-home');

mock.start('screens-send');
await session.send('Run the scripted scenario screens-send.');
await session.panel.waitForSelector('[role="alertdialog"]', { timeout: 30000 });
await shot(session.panel, '2-confirm');

await session.answer('Confirm');
await session.waitForEnd();
await shot(session.panel, '4-done');

const running = await openSession(extension, mock);
mock.start('screens-run');
await running.send('Run the scripted scenario screens-run.');
await sleep(5000);
await shot(running.panel, '5-running');

await running.panel.bringToFront();
await running.panel.evaluate(() => document.querySelector('button[aria-label="Knowledge base"][aria-pressed]').click());
await shot(running.panel, '6-memory');
await running.panel.evaluate(text => {
  const input = document.querySelector('.mo-field');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, 'What did we decide about Stage 2?');
await sleep(200);
await running.panel.evaluate(() => document.querySelector('.mo-send').click());
await sleep(2600);
await shot(running.panel, '7-memory-thinking');
await running.panel.waitForSelector('.mo-root[data-phase="answered"]', { timeout: 30000 });
await shot(running.panel, '8-memory-answer');

await running.panel.evaluate(() => document.querySelector('button[aria-label="Settings"]').click());
await shot(running.panel, '9-settings');

const home = await openSession(extension, mock);
await home.panel.bringToFront();
await home.panel.evaluate(() => document.querySelector('button[aria-label="Open today\'s numbers"]').click());
await shot(home.panel, '10-today');

await extension.close();
await mock.close();
