import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startMockLlm, startMockOllama } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end test of "a local model when the cloud fails": the browser agent's cloud model answers every chat with
 * 429 "quota exceeded"; after the usage meter's retries the same step runs on the local model (a stand-in for
 * Ollama passing chats to the scripted model), the task finishes, the chat says which model finished it, and usage
 * is counted for the local model. The Models hub's "When the cloud fails" card shows the model and its switch.
 */

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];

/** Whether nothing listens on a port (a real Ollama would answer instead of the stand-in). */
const portFree = port =>
  new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(true));
  });

/** A cloud provider whose quota is spent: it lists its model, and refuses every chat with a 429. */
async function startSpentCloud() {
  const chats = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    for await (const _chunk of req) {
      // drain
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'scripted', object: 'model' }] }));
    }
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      chats.push(Date.now());
      // A short Retry-After, so the meter's retries take a moment, not half a minute
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0.05' });
      return res.end(
        JSON.stringify({
          error: {
            message: 'You exceeded your current quota.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
      );
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    chats,
    close: () =>
      new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

async function until(check, what, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}. Last: ${JSON.stringify(last)?.slice(0, 300)}`);
}

/** Reads a table of the extension's database through an extension page. */
function readTable(page, table) {
  return page.evaluate(
    table =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction(table, 'readonly').objectStore(table).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        };
      }),
    table,
  );
}

let mock;
let cloud;
let ollama;
let extension;
let skip = false;

before(async () => {
  if (!(await portFree(11434))) {
    skip = true;
    return;
  }
  mock = await startMockLlm({ 'cloud-spent': [done] });
  cloud = await startSpentCloud();
  ollama = await startMockOllama(mock, { models: ['qwen3:4b'] });
  extension = await launchExtension(mock);
  const agent = { provider: 'openai', modelName: 'scripted' };
  await extension.setStorage({
    'llm-api-keys': {
      providers: {
        openai: {
          name: 'OpenAI',
          type: 'openai',
          apiKey: 'sk-e2e-spent',
          baseUrl: cloud.baseUrl,
          modelNames: ['scripted'],
          createdAt: Date.now(),
        },
        ollama: {
          name: 'Ollama',
          type: 'ollama',
          apiKey: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelNames: ['qwen3:4b'],
          createdAt: Date.now(),
        },
      },
    },
    'agent-models': { agents: { navigator: agent, planner: agent } },
  });
});

after(async () => {
  await extension?.close();
  await ollama?.close();
  await cloud?.close();
  await mock?.close();
});

test('a task whose cloud model is out of quota finishes on the local model, and says so', async t => {
  if (skip) return t.skip('something already listens on 11434');
  mock.start('cloud-spent');
  const session = await openSession(extension, mock);
  await session.send('Run the scripted scenario cloud-spent.');
  const text = await session.waitForEnd(90000);
  assert.match(text, /E2E scenario finished/);
  assert.match(text, /OpenAI failed \(quota\)\. Finishing with qwen3:4b on this computer\./);
  assert.ok(cloud.chats.length >= 1, 'the cloud model was asked first');
  assert.ok(mock.runs.get('cloud-spent').navigatorCalls.length > 0, 'the navigator was answered through Ollama');
  assert.deepEqual(mock.runs.get('cloud-spent').errors, []);
  // Once switched, later steps go straight to the local model: the cloud was tried for one call only
  assert.ok(cloud.chats.length <= 5, `the cloud was asked ${cloud.chats.length} times`);

  const options = await extension.browser.newPage();
  await options.goto(`${extension.origin}/options.html`);
  const events = await until(async () => {
    const rows = await readTable(options, 'usageEvents');
    return rows.some(row => row.providerId === 'ollama') ? rows : null;
  }, 'usage events');
  assert.ok(events.some(row => row.providerId === 'ollama' && row.model === 'qwen3:4b' && row.costUsd === 0));
  assert.ok(!events.some(row => row.providerId === 'openai'), 'failed cloud calls cost nothing');
  await options.close();
  await session.close();
});

test('the Models hub shows the local model a failed cloud call finishes on, with its switch', async t => {
  if (skip) return t.skip('something already listens on 11434');
  const panel = await extension.browser.newPage();
  await panel.setViewport({ width: 400, height: 1400 });
  await panel.goto(`${extension.origin}/options.html`);
  await panel.bringToFront();
  // The settings page opens the same Models hub as the panel
  await until(
    () =>
      panel.evaluate(() => {
        const item = [...document.querySelectorAll('button, a, [role="tab"]')].find(el =>
          /^Models/.test(el.innerText?.trim() ?? ''),
        );
        item?.click();
        return Boolean(document.querySelector('[data-place="models"]'));
      }),
    'the Models hub',
  );
  await panel.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')].find(el => el.innerText.trim() === 'Local')?.click(),
  );
  const status = await until(
    () => panel.evaluate(() => document.querySelector('[data-fallback-model]')?.getAttribute('data-fallback-model')),
    'the fallback model',
  );
  assert.equal(status, 'qwen3:4b');
  assert.match(
    await panel.evaluate(() => document.querySelector('section[aria-label="When the cloud fails"]')?.innerText ?? ''),
    /Failed cloud calls finish on Ollama · qwen3:4b/,
  );
  const options = await panel.$$eval('#models-fallback-model option', items => items.map(item => item.value));
  assert.deepEqual(options, ['', 'ollama|qwen3:4b']);

  await panel.select('#models-fallback-model', 'ollama|qwen3:4b');
  await until(
    async () => (await extension.getStorage('model-settings'))?.fallbackLocal?.model?.model === 'qwen3:4b',
    'the chosen model saved',
  );
  await panel.click('[role="switch"][aria-label="Finish on a local model"]');
  await until(
    async () => (await extension.getStorage('model-settings'))?.fallbackLocal?.enabled === false,
    'the switch saved',
  );
  await until(
    () => panel.evaluate(() => document.querySelector('[data-fallback]')?.getAttribute('data-fallback') === 'off'),
    'the switch shown off',
  );
  assert.equal(await panel.$('[data-fallback-model]'), null, 'no "finish on" line while it is off');
  await panel.close();
});
