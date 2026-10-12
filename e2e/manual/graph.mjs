// Screenshots of the knowledge graph, and a quick look at how it holds up at the ~2 000 node cap.
// Run: node e2e/manual/graph.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, openSession, sleep } from '../harness.mjs';

const out = process.argv[2] ?? 'screens';
fs.mkdirSync(out, { recursive: true });

/** Writes records straight into the extension's database, the same way the graph builder would. */
function writeStore(page, name, records) {
  return page.evaluate(
    (name, records) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(name, 'readwrite');
          for (const record of records) tx.objectStore(name).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    name,
    records,
  );
}

async function openKnowledgeGraph(session) {
  await session.click('Menu');
  await session.click('Knowledge base');
  await session.panel.waitForSelector('[role="tablist"][aria-label="Knowledge base"]', { timeout: 10000 });
  await session.click('Graph');
}

/** A ~2 000 node graph with a hub-and-spoke-ish degree distribution: each node links to a few
 * earlier ones, chosen with a mild bias to the busiest nodes so some become clear hubs. */
function generateLargeGraph(nodeCount) {
  const types = ['project', 'person', 'organization', 'decision', 'action'];
  const now = Date.now();
  const nodes = [];
  const edges = [];
  for (let i = 0; i < nodeCount; i++) {
    const type = types[i % types.length];
    nodes.push({
      id: `n${i}`,
      type,
      label: `${type[0].toUpperCase()}${type.slice(1)} ${i}`,
      workspaceId: null,
      sourceItemIds: [],
      date: now - Math.floor(Math.random() * 120) * 24 * 60 * 60 * 1000,
      updatedAt: now,
    });
    if (i === 0) continue;
    const links = 1 + Math.floor(Math.random() * 3);
    for (let l = 0; l < links; l++) {
      // Biased toward low indices, so early nodes accrue more links and become hubs
      const target = Math.floor(Math.pow(Math.random(), 2) * i);
      edges.push({ id: `e${i}-${l}`, from: `n${i}`, to: `n${target}`, kind: 'mentions', sourceItemId: `n${i}` });
    }
  }
  return { nodes, edges };
}

const mock = await startMockLlm({});
const extension = await launchExtension(mock);

// --- A small, realistic graph: what most people will actually see -------------------------------
{
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
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 900 });
  await session.click('Menu');
  await session.click('Knowledge base');
  await session.web.bringToFront();
  await session.click('Save this page');
  await sleep(4000);
  await session.panel.bringToFront();
  await session.click('Graph');
  // Physics is live now, not an instant layout: give it a moment to settle before the "after" shot
  await sleep(300);
  await session.panel.screenshot({ path: path.join(out, 'graph-settling.png') });
  await sleep(1500);
  await session.panel.screenshot({ path: path.join(out, 'graph.png') });
  await session.click('Sponsor deck');
  await sleep(500);
  await session.panel.screenshot({ path: path.join(out, 'graph-focus.png') });

  // Light theme, same data
  await session.panel.evaluate(() => localStorage.setItem('avi-copilot-theme', 'light'));
  await session.panel.reload();
  await session.panel.setViewport({ width: 400, height: 900 });
  await openKnowledgeGraph(session);
  await sleep(1500);
  await session.panel.screenshot({ path: path.join(out, 'graph-light.png') });

  mock.kb.graphReading = { people: [], organizations: [], projects: [], decisions: [], actions: [] };
  await session.close();
}

// --- The ~2 000 node cap: seeded directly, so this measures the view, not the model call ---------
{
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 900 });
  const consoleErrors = [];
  session.panel.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const { nodes, edges } = generateLargeGraph(2000);
  const seedStart = Date.now();
  await writeStore(session.panel, 'graphNodes', nodes);
  await writeStore(session.panel, 'graphEdges', edges);
  console.log(`Seeded ${nodes.length} nodes / ${edges.length} edges in ${Date.now() - seedStart}ms`);

  const openStart = Date.now();
  await openKnowledgeGraph(session);
  await session.panel.waitForSelector('[role="img"][aria-label^="Map of"]', { timeout: 10000 });
  console.log(`Graph tab open, canvas present after ${Date.now() - openStart}ms`);

  await sleep(2500); // physics settling at this size
  await session.panel.screenshot({ path: path.join(out, 'graph-2000.png') });

  // A UI action should still answer quickly: toggling a type chip off should shrink the node count
  // the canvas reports, not just redraw the same thing
  const before = await session.panel.$eval('[role="img"][aria-label^="Map of"]', el => el.getAttribute('aria-label'));
  const interactStart = Date.now();
  await session.click('Projects');
  await session.panel.waitForFunction(
    previous => document.querySelector('[role="img"]')?.getAttribute('aria-label') !== previous,
    { polling: 50 },
    before,
  );
  console.log(`Type chip toggle round-trip: ${Date.now() - interactStart}ms`);

  const fitStart = Date.now();
  await session.click('Fit view');
  await sleep(700);
  console.log(`Fit view clicked and settled: ${Date.now() - fitStart}ms`);

  console.log(
    consoleErrors.length === 0 ? 'No console errors at 2 000 nodes.' : `Console errors: ${consoleErrors.join(' | ')}`,
  );
  await session.close();
}

await extension.close();
await mock.close();
