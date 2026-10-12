import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession } from './harness.mjs';

/**
 * End-to-end tests of the interactive knowledge graph (Knowledge base › Graph): the panel renders
 * the force graph, the accessible "most connected" list focuses a node (the canvas itself is driven
 * by physics and is not a reliable click target in a test), the agent filter narrows what is shown,
 * and Fit works without raising a console error or a CSP violation. Data is written straight into the
 * extension's IndexedDB, the same way e2e/kb.e2e.mjs seeds a finished meeting: faster and more
 * deterministic than driving the graph builder's model call for every node.
 */

let mock;
let extension;

before(async () => {
  mock = await startMockLlm({});
  extension = await launchExtension(mock);
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

/** Reads a whole object store of the extension's database, through an extension page. */
function readStore(page, name) {
  return page.evaluate(
    name =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction(name).objectStore(name).getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        };
      }),
    name,
  );
}

/** Writes records straight into the extension's database, as the graph builder would leave them. */
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

async function openKnowledge(session) {
  await session.click('Menu');
  await session.click('Knowledge base');
  await session.panel.waitForSelector('[role="tablist"][aria-label="Knowledge base"]', { timeout: 10000 });
}

function agentProfile(id, name) {
  const now = Date.now();
  return {
    id,
    name,
    avatar: '',
    instructions: '',
    skills: [],
    connectors: [],
    domains: [],
    modelRole: 'fast',
    workspaceId: null,
    executor: 'browser',
    triggers: [],
    subscribes: [],
    publishes: [],
    budget: { dailyUsd: null, maxStepsPerRun: 20, runsPerDay: 10 },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Two agents, each with their own saved page, each page mentioning its own project and a person
 * both pages mention. Picking one agent should keep that agent's project and the shared person, and
 * drop the other agent's project.
 */
async function seedGraph(page) {
  const now = Date.now();
  await writeStore(page, 'kbItems', [
    {
      id: 'page:ava-1',
      sourceType: 'page',
      sourceId: 'https://example.com/ava',
      title: "Ava's page",
      url: 'https://example.com/ava',
      sourceDate: now,
      sourceUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
      chunkCount: 0,
      unembedded: 0,
      workspaceId: null,
      agentId: 'agent-ava',
    },
    {
      id: 'page:nova-1',
      sourceType: 'page',
      sourceId: 'https://example.com/nova',
      title: "Nova's page",
      url: 'https://example.com/nova',
      sourceDate: now,
      sourceUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
      chunkCount: 0,
      unembedded: 0,
      workspaceId: null,
      agentId: 'agent-nova',
    },
  ]);
  await writeStore(page, 'graphNodes', [
    {
      id: 'page:ava-1',
      type: 'page',
      label: "Ava's page",
      workspaceId: null,
      sourceItemIds: ['page:ava-1'],
      date: now,
      updatedAt: now,
    },
    {
      id: 'page:nova-1',
      type: 'page',
      label: "Nova's page",
      workspaceId: null,
      sourceItemIds: ['page:nova-1'],
      date: now,
      updatedAt: now,
    },
    {
      id: 'project:-:atlas launch',
      type: 'project',
      label: 'Atlas Launch',
      workspaceId: null,
      sourceItemIds: ['page:ava-1'],
      date: now,
      updatedAt: now,
    },
    {
      id: 'project:-:nimbus rollout',
      type: 'project',
      label: 'Nimbus Rollout',
      workspaceId: null,
      sourceItemIds: ['page:nova-1'],
      date: now,
      updatedAt: now,
    },
    {
      id: 'person:-:ada lovelace',
      type: 'person',
      label: 'Ada Lovelace',
      workspaceId: null,
      sourceItemIds: ['page:ava-1', 'page:nova-1'],
      date: now,
      updatedAt: now,
    },
  ]);
  await writeStore(page, 'graphEdges', [
    { id: 'e1', from: 'page:ava-1', to: 'project:-:atlas launch', kind: 'mentions', sourceItemId: 'page:ava-1' },
    { id: 'e2', from: 'page:nova-1', to: 'project:-:nimbus rollout', kind: 'mentions', sourceItemId: 'page:nova-1' },
    { id: 'e3', from: 'page:ava-1', to: 'person:-:ada lovelace', kind: 'mentions', sourceItemId: 'page:ava-1' },
    { id: 'e4', from: 'page:nova-1', to: 'person:-:ada lovelace', kind: 'mentions', sourceItemId: 'page:nova-1' },
  ]);
  await writeStore(page, 'agents', [agentProfile('agent-ava', 'Ava'), agentProfile('agent-nova', 'Nova')]);
}

/** Watches for console errors and CSP violations from here on, for the caller to assert against. */
async function watchForTrouble(page) {
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.evaluate(() => {
    window.__cspViolations = [];
    window.addEventListener('securitypolicyviolation', event => {
      window.__cspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
  return {
    consoleErrors,
    cspViolations: () => page.evaluate(() => window.__cspViolations),
  };
}

test('the graph renders, the accessible list focuses a node, and Fit works cleanly', async () => {
  const session = await openSession(extension, mock);
  const trouble = await watchForTrouble(session.panel);
  await seedGraph(session.panel);

  await openKnowledge(session);
  await session.click('Graph');

  // The canvas region is up, described by how many things are shown
  await session.panel.waitForSelector('[role="img"][aria-label^="Map of"]', { timeout: 10000 });
  await session.panel.waitForFunction(() => document.body.innerText.includes('Atlas Launch'), { polling: 300 });
  assert.match(await session.panelText(), /Nimbus Rollout/);

  // Click-to-focus through the accessible "most connected" list (the canvas itself is physics-placed
  // and not a reliable click target), then check the focus card it opens
  await session.click('Atlas Launch');
  await session.panel.waitForFunction(() => document.body.innerText.includes("Ava's page"), { polling: 300 });
  const focused = await session.panelText();
  assert.match(focused, /Mentioned in/i);
  assert.match(focused, /Ava's page/);

  // Fit does not throw and leaves the canvas in place
  await session.click('Fit view');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Atlas Launch'), { polling: 300 });

  assert.deepEqual(session.panelErrors, [], 'no uncaught page errors');
  assert.deepEqual(trouble.consoleErrors, [], 'no console errors');
  assert.deepEqual(await trouble.cspViolations(), [], 'no CSP violations');
  await session.close();
});

test('the agent filter narrows the graph to one agent’s knowledge', async () => {
  const session = await openSession(extension, mock);
  const trouble = await watchForTrouble(session.panel);
  // The previous test's data is already in the shared database; seeding again is a harmless no-op put
  await seedGraph(session.panel);

  await openKnowledge(session);
  await session.click('Graph');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Nimbus Rollout'), { polling: 300 });

  // The agent picker sits next to the workspace picker, above the tabs' content
  await session.panel.waitForFunction(() => document.body.innerText.includes('Ava'), { polling: 300 });
  const picked = await session.panel.evaluate(() => {
    const select = [...document.querySelectorAll('select')].find(el =>
      [...el.options].some(option => option.text === 'Ava'),
    );
    if (!select) return false;
    const option = [...select.options].find(o => o.text === 'Ava');
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  assert.ok(picked, 'the agent picker lists Ava');

  await session.panel.waitForFunction(() => !document.body.innerText.includes('Nimbus Rollout'), {
    polling: 300,
    timeout: 10000,
  });
  const text = await session.panelText();
  assert.match(text, /Atlas Launch/, 'Ava’s own project stays');
  assert.doesNotMatch(text, /Nimbus Rollout/, 'Nova’s project is filtered out');

  assert.deepEqual(session.panelErrors, [], 'no uncaught page errors');
  assert.deepEqual(trouble.consoleErrors, [], 'no console errors');
  assert.deepEqual(await trouble.cspViolations(), [], 'no CSP violations');
  await session.close();
});
