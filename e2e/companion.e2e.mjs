// Nex Brain, the companion on the Mac, against a mock that speaks the real protocol: pairing from
// Settings, its status, a routine's step.sandbox run on the Mac, and an artifact in an Avi Studio tab that
// cannot load a remote image. Needs `import './companion/register';` in src/side-panel/registers.ts.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchExtension, openSession, sleep } from './harness.mjs';
import { startMockCompanion } from './mock-companion.mjs';
import { startMockLlm } from './mock-llm.mjs';

const EXTENSION_ORIGIN = 'chrome-extension://fckijnclcihjnokahdnbogpbeiimfdio';
const SECTION = 'section[aria-label="Nex Brain (Mac)"]';

let mock;
let companion;
let extension;
let session;

before(async () => {
  mock = await startMockLlm({});
  companion = await startMockCompanion();
  extension = await launchExtension(mock);
  session = await openSession(extension, mock);
});

after(async () => {
  await session?.close().catch(() => {});
  await extension?.close();
  await companion?.close();
  await mock?.close();
});

async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`${message} (timed out)`);
}

function readStore(page, store) {
  return page.evaluate(
    store =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction(store).objectStore(store).getAll();
          all.onsuccess = () => {
            resolve(all.result);
            open.result.close();
          };
          all.onerror = () => reject(all.error);
        };
      }),
    store,
  );
}

/** Sends a registered command over a port of its own, as the panel's PanelApi does, and returns the reply. */
function command(page, message) {
  return page.evaluate(
    message =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'side-panel-connection' });
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          port.disconnect();
          reject(new Error(`No reply to ${message.type}`));
        }, 20000);
        port.onMessage.addListener(reply => {
          if (reply.requestId !== requestId) return;
          clearTimeout(timer);
          port.disconnect();
          if (reply.type === 'error') reject(new Error(reply.error));
          else resolve(reply);
        });
        port.postMessage({ ...message, requestId });
      }),
    message,
  );
}

/** Types into a labelled input the way React hears it. */
function type(page, label, value) {
  return page.evaluate(
    (label, value) => {
      const input = document.querySelector(`input[aria-label="${label}"]`);
      if (!input) throw new Error(`No input "${label}"`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    label,
    value,
  );
}

const sectionText = () =>
  session.panel.evaluate(selector => document.querySelector(selector)?.innerText ?? '', SECTION);

test('pairs with Nex Brain from Settings and shows it connected', async () => {
  assert.equal(extension.origin, EXTENSION_ORIGIN, 'the extension ID is pinned, so the companion knows its origin');
  const { panel } = session;
  await panel.bringToFront();
  await session.click('Menu');
  await session.openAccountMenu();
  await session.click('Settings');
  await panel.waitForSelector(SECTION, { timeout: 10000 }).catch(async error => {
    throw new Error(`${error.message}. Panel shows: ${(await session.panelText()).slice(0, 600)}`);
  });
  assert.match(await sectionText(), /Not paired/);

  await type(panel, 'Port', String(companion.port));
  // As typed: lower case, a space instead of the dash
  await type(panel, 'Pairing code', 'abcd 2345');
  await panel.evaluate(selector => {
    const button = [...document.querySelector(selector).querySelectorAll('button')].find(
      b => b.innerText.trim() === 'Pair',
    );
    button.click();
  }, SECTION);
  await panel
    .waitForFunction(
      selector => /Connected/.test(document.querySelector(selector)?.innerText ?? ''),
      { polling: 300, timeout: 15000 },
      SECTION,
    )
    .catch(async error => {
      const seen = companion.requests.map(request => `${request.method} ${request.path} origin=${request.origin}`);
      throw new Error(`${error.message}. Section shows: ${await sectionText()}. Requests: ${seen.join('; ')}`);
    });
  const text = await sectionText();
  assert.match(text, /v0\.1\.0-mock/);
  assert.match(text, /Docker\s*Running/);

  // Every API request carried the extension's origin, and every one after pairing the token
  const api = companion.requests.filter(request => request.path.startsWith('/v1/') && request.method !== 'OPTIONS');
  assert.ok(
    api.some(request => request.path === '/v1/health'),
    'health was asked',
  );
  for (const request of api) assert.equal(request.origin, EXTENSION_ORIGIN, `${request.method} ${request.path}`);
  for (const request of api.filter(item => item.path !== '/v1/pair')) {
    assert.equal(request.auth, `Bearer ${companion.token()}`, `${request.method} ${request.path}`);
  }
  // The token lives in the vault: never in extension storage
  const stored = await panel.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  assert.ok(!stored.includes(companion.token()), 'the token is not in storage.local');
  assert.match(stored, /"brain-settings"/);
  assert.deepEqual(session.panelErrors, []);
});

test("a routine's step.sandbox waits for the click, then runs on the Mac and returns its output", async () => {
  const { panel } = session;
  const workflowId = 'wf-brain-e2e';
  const now = Date.now();
  await panel.evaluate(
    record =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction('workflows', 'readwrite');
          transaction.objectStore('workflows').put(record);
          transaction.oncomplete = () => {
            open.result.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    {
      id: workflowId,
      name: 'Build on the Mac',
      description: '',
      workspaceId: null,
      agentId: null,
      spec: {
        name: 'Build on the Mac',
        nodes: [
          { id: 'start', type: 'trigger.manual', label: 'By hand' },
          { id: 'build', type: 'step.sandbox', label: 'Build', command: 'echo hello from the sandbox' },
        ],
        edges: [{ from: 'start', to: 'build' }],
      },
      version: 1,
      status: 'active',
      failuresInRow: 0,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    },
  );

  const { runId } = await command(panel, { type: 'workflow_run', id: workflowId });
  const stepOf = async status =>
    (await readStore(panel, 'runSteps')).find(
      step => step.runId === runId && step.nodeId === 'build' && step.status === status,
    );
  // Running code acts for the user: it waits for their click, and nothing reached the Mac yet
  await until(() => stepOf('waiting_user'), 'the sandbox step waits for approval');
  assert.equal(companion.sandboxRuns.length, 0);

  await command(panel, { type: 'workflow_step_answer', runId, nodeId: 'build', approved: true });
  const done = await until(() => stepOf('succeeded'), 'the sandbox step succeeds');
  assert.equal(done.output.stdout, 'sandbox(routines): echo hello from the sandbox\n');
  assert.equal(done.output.exitCode, 0);
  // One request, named by the run and step, in the sandbox shared by routines without an agent
  assert.deepEqual(
    companion.sandboxRuns.map(run => [run.requestId, run.profileId, run.command]),
    [[`${runId}:build`, 'routines', 'echo hello from the sandbox']],
  );
  const run = await until(
    async () => (await readStore(panel, 'runs')).find(item => item.id === runId && item.status === 'succeeded'),
    'the run succeeds',
  );
  assert.equal(run.tainted, true, 'what a command printed counts as outside content');
});

test('an artifact opens in an Avi Studio tab and cannot load a remote image', async () => {
  const { panel } = session;
  const label = 'Open Remote image test in Avi Studio';
  await panel.bringToFront();
  await panel.waitForSelector(`button[aria-label="${label}"]`, { timeout: 15000 });
  const opened = extension.browser.waitForTarget(target => target.url().includes(`/studio/${companion.artifactId}`), {
    timeout: 15000,
  });
  await session.click(label);
  const studio = await (await opened).asPage();
  await studio.bringToFront();

  // The fragment's one-time token is traded for a view key and wiped from the address
  await studio.waitForFunction(() => location.hash === '' && document.querySelector('iframe') !== null, {
    polling: 300,
    timeout: 15000,
  });
  assert.match(studio.url(), new RegExp(`^http://127\\.0\\.0\\.1:${companion.port}/studio/${companion.artifactId}$`));
  const frame = await (await studio.waitForSelector('iframe')).contentFrame();
  await frame.waitForFunction(
    () => document.body?.dataset.scripted === 'yes' && document.getElementById('remote')?.complete,
    { polling: 300, timeout: 15000 },
  );
  await sleep(500);
  const seen = await frame.evaluate(() => ({
    local: document.getElementById('local').naturalWidth,
    remote: document.getElementById('remote').naturalWidth,
    violations: window.__violations,
    origin: self.origin,
  }));
  assert.equal(seen.local, 1, 'an image carried in the artifact shows');
  assert.equal(seen.remote, 0, 'a remote image does not load');
  assert.ok(
    seen.violations.some(item => item.startsWith('img-src')),
    JSON.stringify(seen.violations),
  );
  assert.deepEqual(companion.remoteHits, [], 'nothing reached the other server');
  assert.equal(seen.origin, 'null', 'the artifact runs in an opaque origin');
  await studio.close();
});
