// Walks the history: one chat, a new one, then back to the first from the list, with screenshots.
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, openSession, sleep } from '../harness.mjs';

const out = process.argv[2] ?? 'screens';
fs.mkdirSync(out, { recursive: true });
const done = () => [{ done: { text: 'ok', success: true } }];
const mock = await startMockLlm({ 'history-one': [done], 'history-two': [done] });
const extension = await launchExtension(mock);
const shot = async (page, name) => {
  await page.setViewport({ width: 400, height: 860 });
  await sleep(700);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('saved', name, (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 300));
};

const session = await openSession(extension, mock);
mock.start('history-one');
await session.send('Run the scripted scenario history-one.');
await session.waitForEnd();
await session.panel.bringToFront();
await session.click('New thread');
await sleep(500);
await session.web.bringToFront();
mock.start('history-two');
await session.send('Run the scripted scenario history-two.');
await session.waitForEnd();
await session.panel.bringToFront();
await session.click('Threads');
await shot(session.panel, 'h1-list');
await session.panel.evaluate(() => {
  const item = [...document.querySelectorAll('button')].find(b => b.innerText.includes('history-one'));
  item?.click();
});
await shot(session.panel, 'h2-opened');
await extension.close();
await mock.close();
