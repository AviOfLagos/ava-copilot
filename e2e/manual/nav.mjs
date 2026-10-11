// Screenshots of the menu, breadcrumbs and "How do I…", for looking at the design.
// Run: node e2e/manual/nav.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, openSession, sleep } from '../harness.mjs';

const out = process.argv[2] ?? 'screens';
fs.mkdirSync(out, { recursive: true });
const mock = await startMockLlm({ 'nav-a': [() => [{ done: { text: 'Done.', success: true } }]] });
const extension = await launchExtension(mock);
const session = await openSession(extension, mock);
await session.panel.setViewport({ width: 400, height: 760 });
mock.start('nav-a');
await session.send('Draft the Tech Ember Fest sponsor email');
await session.waitForEnd();
await session.panel.bringToFront();
await session.panel.screenshot({ path: path.join(out, 'nav-chat.png') });
await session.click('Menu');
await sleep(400);
await session.panel.screenshot({ path: path.join(out, 'nav-menu.png') });
await session.click('How do I…');
await sleep(300);
await session.panel.screenshot({ path: path.join(out, 'nav-help.png') });
await extension.close();
await mock.close();
