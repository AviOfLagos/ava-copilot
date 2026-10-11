// A screenshot of the knowledge graph with a few linked things in it, for looking at the design.
// Run: node e2e/manual/graph.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, openSession, sleep } from '../harness.mjs';

const out = process.argv[2] ?? 'screens';
fs.mkdirSync(out, { recursive: true });
const mock = await startMockLlm({});
mock.kb.graphReading = {
  people: ['Ada Lovelace', 'Grace Hopper', 'Tobi Ade'],
  organizations: ['Acme Bank', 'Lagos Tech Hub'],
  projects: ['Sponsor deck', 'Ticketing', 'Speaker lineup'],
  decisions: ['Sponsor deck goes out Friday', 'Ticketing moves to Paystack'],
  actions: [
    { task: 'Finish the sponsor deck', owner: 'Ada Lovelace' },
    { task: 'Confirm the speaker lineup', owner: 'Tobi Ade' },
    { task: 'Test ticketing checkout', owner: 'Grace Hopper' },
  ],
};
const extension = await launchExtension(mock);
const session = await openSession(extension, mock);
await session.panel.setViewport({ width: 400, height: 900 });
await session.click('Menu');
await session.click('Knowledge base');
await session.web.bringToFront();
await session.click('Save this page');
await sleep(4000);
await session.panel.bringToFront();
await session.click('Graph');
await sleep(800);
await session.panel.screenshot({ path: path.join(out, 'graph.png') });
await session.click('Sponsor deck');
await sleep(500);
await session.panel.screenshot({ path: path.join(out, 'graph-focus.png') });
await extension.close();
await mock.close();
