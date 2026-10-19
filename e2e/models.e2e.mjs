import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of models, keys and usage: plaintext keys move into the encrypted vault and still work,
 * the registry lists what each provider offers (prices, local models, health), the settings page shows
 * keys masked and replaces one through the background, a refused key says so, and model calls are recorded
 * as usage events. A small server here stands in for NVIDIA NIM, OpenRouter and Ollama.
 */

const NVIDIA_KEY = 'nvapi-e2e-secret-4321';
const NVIDIA_KEY_2 = 'nvapi-e2e-second-9876';
const OPENROUTER_KEY = 'sk-or-e2e-secret-8765';

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const scenarios = { 'models-usage': [done] };

/** NVIDIA-, OpenRouter- and Ollama-shaped model lists; NVIDIA takes only the keys it is told to. */
async function startModelServer() {
  const seen = [];
  const nvidiaKeys = new Set([NVIDIA_KEY]);
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization ?? null, body });
    if (req.method === 'GET' && req.url === '/nim/v1/models') {
      const key = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!nvidiaKeys.has(key)) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, {
        object: 'list',
        data: [
          { id: 'meta/llama-3.3-70b-instruct', object: 'model' },
          { id: 'nvidia/nv-embedqa-e5-v5', object: 'model' },
        ],
      });
    }
    if (req.method === 'GET' && req.url === '/api/v1/models') {
      return json(res, 200, {
        data: [
          {
            id: 'anthropic/claude-opus-5-5',
            name: 'Claude Opus 5.5',
            context_length: 400000,
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            pricing: { prompt: '0.000003', completion: '0.000015' },
            supported_parameters: ['tools'],
          },
          {
            id: 'meta-llama/llama-4-scout:free',
            name: 'Llama 4 Scout (free)',
            context_length: 128000,
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: [],
          },
        ],
      });
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      return json(res, 200, { models: [{ name: 'qwen3.8:8b' }, { name: 'nomic-embed-text:latest' }] });
    }
    // Ollama's OpenAI-compatible chat: light work routed here answers as the local model
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const { model } = JSON.parse(body || '{}');
      return json(res, 200, {
        id: 'local-1',
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'A local summary.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
      });
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      const { model } = JSON.parse(body || '{}');
      return json(res, 200, {
        capabilities: model.startsWith('nomic') ? ['embedding'] : ['completion', 'tools'],
        model_info: { 'qwen3.context_length': 40960 },
      });
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, nvidiaKeys, close: () => new Promise(resolve => server.close(resolve)) };
}

let mock;
let models;
let extension;
let options;

before(async () => {
  mock = await startMockLlm(scenarios);
  models = await startModelServer();
  extension = await launchExtension(mock);
  options = await extension.browser.newPage();
  // Settings › Models
  await options.goto(`${extension.origin}/options.html#models`);
});

after(async () => {
  await extension?.close();
  await models?.close();
  await mock?.close();
});

/** Polls until the check returns something truthy, then returns it. */
async function until(check, what, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}. Last: ${JSON.stringify(last)?.slice(0, 500)}`);
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

/** Sends a models_ command on the settings page's own port, as the page does. */
function command(page, message) {
  return page.evaluate(
    message =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'models-settings' });
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => reject(new Error('no reply')), 45000);
        port.onMessage.addListener(reply => {
          if (reply.requestId !== requestId) return;
          clearTimeout(timer);
          port.disconnect();
          resolve(reply);
        });
        port.postMessage({ ...message, requestId });
      }),
    message,
  );
}

test('plaintext keys move into the encrypted vault, and storage keeps only their last characters', async () => {
  const current = await extension.getStorage('llm-api-keys');
  await extension.setStorage({
    'llm-api-keys': {
      providers: {
        ...current.providers,
        nvidia: {
          name: 'NVIDIA NIM',
          type: 'nvidia',
          apiKey: NVIDIA_KEY,
          baseUrl: `${models.url}/nim/v1`,
          modelNames: [],
          createdAt: Date.now(),
        },
        openrouter: {
          name: 'OpenRouter',
          type: 'openrouter',
          apiKey: OPENROUTER_KEY,
          baseUrl: `${models.url}/api/v1`,
          modelNames: ['anthropic/claude-opus-5-5'],
          createdAt: Date.now(),
        },
        ollama: {
          name: 'Ollama',
          type: 'ollama',
          apiKey: 'ollama',
          baseUrl: `${models.url}/v1`,
          modelNames: [],
          createdAt: Date.now(),
        },
      },
    },
  });

  const stored = await until(async () => {
    const value = await extension.getStorage('llm-api-keys');
    return value?.providers?.nvidia?.hasKey && value.providers.openrouter?.hasKey && value.providers.mock?.hasKey
      ? value
      : null;
  }, 'the keys to move into the vault');
  const text = JSON.stringify(stored);
  assert.ok(!text.includes(NVIDIA_KEY) && !text.includes(OPENROUTER_KEY), 'no key left in plaintext storage');
  assert.equal(stored.providers.mock.apiKey, '');
  assert.equal(stored.providers.nvidia.keyLast4, '4321');
  assert.equal(stored.providers.openrouter.keyLast4, '8765');
  // A local server's stand-in key guards nothing and stays
  assert.equal(stored.providers.ollama.apiKey, 'ollama');

  // The vault holds them encrypted, under a key that cannot be exported
  const vault = await options.evaluate(
    keys =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-secrets');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(['secrets', 'keys'], 'readonly');
          const secrets = tx.objectStore('secrets').getAll();
          const master = tx.objectStore('keys').getAll();
          tx.oncomplete = () => {
            const plain = secrets.result.some(record => {
              const bytes = new TextDecoder().decode(new Uint8Array(record.data));
              return keys.some(key => bytes.includes(key));
            });
            resolve({
              refs: secrets.result.map(record => record.ref).sort(),
              plain,
              extractable: master.result[0]?.key?.extractable,
            });
          };
        };
      }),
    [NVIDIA_KEY, OPENROUTER_KEY, 'test'],
  );
  assert.deepEqual(vault.refs, ['llm:mock', 'llm:nvidia', 'llm:openrouter']);
  assert.equal(vault.plain, false);
  assert.equal(vault.extractable, false);
});

test('the registry lists each provider’s models with prices, local models and health, using the vault’s keys', async () => {
  const reply = await command(options, { type: 'models_refresh' });
  assert.equal(reply.type, 'models_refresh_started');

  const catalog = await until(async () => {
    const rows = await readTable(options, 'modelCatalog');
    const providers = new Set(rows.map(row => row.providerId));
    return ['nvidia', 'openrouter', 'ollama'].every(id => providers.has(id)) ? rows : null;
  }, 'the catalog to list the providers');
  const byId = Object.fromEntries(catalog.map(row => [row.id, row]));

  assert.deepEqual(
    [
      byId['openrouter:anthropic/claude-opus-5-5'].inputUsdPerM,
      byId['openrouter:anthropic/claude-opus-5-5'].outputUsdPerM,
    ],
    [3, 15],
  );
  assert.equal(byId['openrouter:anthropic/claude-opus-5-5'].local, false);
  assert.equal(byId['openrouter:meta-llama/llama-4-scout:free'].outputUsdPerM, 0);
  assert.equal(byId['ollama:qwen3.8:8b'].local, true);
  assert.equal(byId['ollama:qwen3.8:8b'].contextTokens, 40960);
  assert.ok(byId['ollama:nomic-embed-text:latest'].modalities.includes('embedding'));
  assert.ok(byId['nvidia:meta/llama-3.3-70b-instruct'].modalities.includes('chat'));

  // The background decrypted each key and sent it to its own provider only
  assert.ok(models.seen.some(request => request.path === '/nim/v1/models' && request.auth === `Bearer ${NVIDIA_KEY}`));
  assert.ok(
    models.seen.some(request => request.path === '/api/v1/models' && request.auth === `Bearer ${OPENROUTER_KEY}`),
  );
  assert.ok(models.seen.filter(request => request.path === '/api/tags').every(request => request.auth === null));

  const health = await until(async () => {
    const value = await extension.getStorage('model-health');
    return value?.providers?.nvidia && value?.providers?.openrouter ? value : null;
  }, 'provider health');
  assert.equal(health.providers.nvidia.status, 'ok');
  assert.equal(health.providers.openrouter.models, 2);
  assert.ok(!JSON.stringify(health).includes(NVIDIA_KEY));
});

test('the settings page shows keys masked, replaces one through the background, and says when one is refused', async () => {
  await options.reload();
  const card = '[data-provider="nvidia"]';
  await options.waitForSelector(`${card} [data-key-display]`, { timeout: 10000 });
  assert.equal(await options.$eval(`${card} [data-key-display]`, el => el.textContent), '••••4321');
  const pageText = await options.evaluate(() => document.body.innerText);
  assert.ok(!pageText.includes(NVIDIA_KEY) && !pageText.includes(OPENROUTER_KEY), 'no key on the page');

  // The same Models page as the panel's: "Replace key" opens the editor, whose key field starts empty
  const clickIn = (card, label) =>
    options.evaluate(
      (card, label) => {
        const button = [...document.querySelectorAll(`${card} button`)].find(b => b.innerText.trim() === label);
        button?.click();
        return Boolean(button);
      },
      card,
      label,
    );
  const saveWithKey = async key => {
    if (!(await options.$('#models-nvidia-key'))) assert.ok(await clickIn(card, 'Replace key'));
    await options.waitForSelector('#models-nvidia-key', { timeout: 5000 });
    assert.equal(await options.$eval('#models-nvidia-key', el => el.value), '', 'the key field starts empty');
    await options.click('#models-nvidia-key', { clickCount: 3 });
    await options.type('#models-nvidia-key', key);
    assert.ok(await clickIn(card, 'Save'));
  };

  // A key the provider refuses is saved, and the page says so
  await saveWithKey('nvapi-refused-key-0000');
  await until(
    () => options.evaluate(card => document.querySelector(card).innerText.includes('refused this key'), card),
    'the refused-key message',
  );

  // A good one replaces it: the provider is asked with it, and storage keeps its last four
  models.nvidiaKeys.add(NVIDIA_KEY_2);
  await saveWithKey(NVIDIA_KEY_2);
  await until(
    () => options.evaluate(card => /answered with 2 models/.test(document.querySelector(card).innerText), card),
    'the check after saving',
  );
  assert.ok(models.seen.some(request => request.auth === `Bearer ${NVIDIA_KEY_2}`));
  const stored = await extension.getStorage('llm-api-keys');
  assert.equal(stored.providers.nvidia.keyLast4, '9876');
  assert.ok(!JSON.stringify(stored).includes(NVIDIA_KEY_2));
  assert.equal(await options.$eval(`${card} [data-key-display]`, el => el.textContent), '••••9876');
});

test('model calls are recorded as usage events, with no price for a model nobody prices', async () => {
  const session = await openSession(extension, mock);
  mock.start('models-usage');
  await session.send('Run the scripted scenario models-usage');
  await session.waitForEnd();
  const threadId = await session.panel.evaluate(() => new URLSearchParams(location.search).get('thread'));

  const events = await until(async () => {
    const rows = await readTable(options, 'usageEvents');
    return rows.filter(row => row.providerId === 'mock').length ? rows : null;
  }, 'usage events');
  const mine = events.filter(row => row.providerId === 'mock');
  assert.ok(mine.every(row => row.costUsd === null && row.role === 'thread' && row.model === 'scripted'));
  assert.ok(mine.every(row => row.inputTokens > 0));
  if (threadId) assert.ok(mine.some(row => row.sessionId === threadId));

  const usage = await extension.getStorage('usage');
  const today = Object.values(usage.days).at(-1);
  assert.ok(today.unpricedTokens > 0, 'tokens of a model with no price count against their own cap');
  await session.close();
});

/** Opens the panel on the Models & usage page, from the drawer or the profile menu. */
async function openModelsPage() {
  const panel = await extension.browser.newPage();
  await panel.setViewport({ width: 400, height: 1400 });
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.waitForSelector('textarea');
  await panel.bringToFront();
  const clickByName = name =>
    panel.evaluate(name => {
      const button = [...document.querySelectorAll('button, [role="menuitem"]')].find(
        el => el.innerText?.trim() === name || el.getAttribute('aria-label') === name,
      );
      button?.click();
      return Boolean(button);
    }, name);
  await clickByName('Menu');
  await sleep(300);
  let found = await clickByName('Models & usage');
  if (!found) {
    // The profile menu at the drawer's foot opens on a key press (Radix), with the panel in front
    await panel.bringToFront();
    await panel.evaluate(() => {
      const button = document.querySelector('[aria-label="Account menu"]');
      button?.focus();
      button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await sleep(300);
    found = await clickByName('Models & usage');
  }
  assert.ok(found, 'Models & usage is reachable from the profile menu');
  await panel.waitForSelector('[data-place="models"]', { timeout: 10000 });
  return panel;
}

/** Clicks one of the Models page's tabs. */
async function openTab(page, label) {
  const found = await page.evaluate(label => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(el => el.innerText.trim() === label);
    tab?.click();
    return Boolean(tab);
  }, label);
  assert.ok(found, `the ${label} tab`);
  await sleep(300);
}

/** The model names a role's picker offers. */
const roleOptions = (page, role) =>
  page.evaluate(
    role => [...document.querySelectorAll(`#models-role-${role} option`)].map(option => option.value),
    role,
  );

test('the Models & usage page in the panel lists providers, models and usage', async () => {
  const panel = await openModelsPage();
  await until(
    () => panel.evaluate(() => document.querySelector('[data-provider="nvidia"] [data-key-display]')?.textContent),
    'the masked key in the panel',
  );
  assert.equal(await panel.$eval('[data-provider="nvidia"] [data-key-display]', el => el.textContent), '••••9876');
  await until(
    () => panel.evaluate(() => document.querySelector('[data-model="openrouter:anthropic/claude-opus-5-5"]') !== null),
    'the catalog in the panel',
  );
  assert.match(
    await panel.$eval('[data-model="openrouter:anthropic/claude-opus-5-5"]', el => el.innerText),
    /\$3\s*\/\s*\$15\b/,
  );
  await openTab(panel, 'Usage');
  await until(
    () =>
      panel.evaluate(() => Number(document.querySelector('[data-usage-total]')?.getAttribute('data-usage-total')) > 0),
    'usage in the panel',
  );
  const text = await panel.evaluate(() => document.body.innerText);
  assert.ok(!text.includes(NVIDIA_KEY_2) && !text.includes(OPENROUTER_KEY), 'no key in the panel');
  await panel.close();
});

test('models are turned on and off, and roles offer only the ones that are on', async () => {
  const panel = await openModelsPage();
  const free = 'openrouter:meta-llama/llama-4-scout:free';
  const opus = 'openrouter|anthropic/claude-opus-5-5';
  await panel.waitForSelector(`[data-model="${free}"] [role="switch"]`, { timeout: 15000 });
  // OpenRouter was saved with Claude Opus only: the free Llama is off, and no role offers it
  assert.equal(await panel.$eval(`[data-model="${free}"]`, el => el.dataset.active), 'false');
  await openTab(panel, 'Roles');
  await panel.waitForSelector('#models-role-fast');
  let fast = await roleOptions(panel, 'fast');
  assert.ok(fast.includes(opus), 'an active model is offered');
  assert.ok(!fast.includes('openrouter|meta-llama/llama-4-scout:free'), 'a model that is off is not offered');

  // Turned on, it is offered; the provider's saved list is what changed
  await openTab(panel, 'Models');
  await panel.click(`[data-model="${free}"] [role="switch"]`);
  await until(async () => {
    const stored = await extension.getStorage('llm-api-keys');
    return stored.providers.openrouter.modelNames.includes('meta-llama/llama-4-scout:free');
  }, 'the model to be turned on');
  await openTab(panel, 'Roles');
  fast = await until(async () => {
    const options = await roleOptions(panel, 'fast');
    return options.includes('openrouter|meta-llama/llama-4-scout:free') ? options : null;
  }, 'the role to offer the model');

  // And off again: gone from the picker, and from storage
  await openTab(panel, 'Models');
  await panel.click(`[data-model="${free}"] [role="switch"]`);
  await until(async () => {
    const stored = await extension.getStorage('llm-api-keys');
    return !stored.providers.openrouter.modelNames.includes('meta-llama/llama-4-scout:free');
  }, 'the model to be turned off');
  await openTab(panel, 'Roles');
  await until(
    async () => !(await roleOptions(panel, 'fast')).includes('openrouter|meta-llama/llama-4-scout:free'),
    'the role to stop offering it',
  );
  // Keys never reach storage in the clear while toggling
  assert.ok(!JSON.stringify(await extension.getStorage('llm-api-keys')).includes(OPENROUTER_KEY));
  await panel.close();
});

test('local models that fit this computer are recommended, with install commands and installed ones marked', async () => {
  const panel = await openModelsPage();
  await openTab(panel, 'Local');
  await panel.waitForSelector('[data-recommendation]', { timeout: 10000 });
  const recs = await panel.$$eval('[data-recommendation]', items =>
    items.map(item => ({
      name: item.dataset.recommendation,
      installed: item.dataset.installed,
      command: item.querySelector('[data-command]')?.textContent ?? null,
    })),
  );
  assert.ok(recs.length >= 2 && recs.length <= 4, `2–4 recommendations, got ${recs.length}`);
  assert.ok(
    recs.some(rec => rec.name === 'nomic-embed-text' && rec.installed === 'true'),
    'installed one is marked',
  );
  for (const rec of recs.filter(rec => rec.installed === 'false')) {
    assert.equal(rec.command, `ollama pull ${rec.name}`);
  }
  // Telling it the computer has more memory changes the advice
  await panel.evaluate(() =>
    [...document.querySelectorAll('[role="radio"]')].find(el => el.innerText.trim() === '64 GB')?.click(),
  );
  await until(
    () => panel.evaluate(() => document.querySelector('[data-recommendation="qwen3:30b"]') !== null),
    'bigger models for 64 GB',
  );
  assert.match(await panel.$eval('[data-spec]', el => el.innerText), /64 GB/);
  await panel.close();
});

test('light work runs on the running local model, and what that saved shows in usage', async () => {
  // OpenRouter's cheap model is the cloud alternative a summary would otherwise use
  await extension.setStorage({
    'model-settings': { roles: { fast: { providerId: 'openrouter', model: 'anthropic/claude-opus-5-5' } } },
  });
  const panel = await openModelsPage();
  await openTab(panel, 'Local');
  await until(
    () => panel.evaluate(() => document.querySelector('[data-light-route]')?.getAttribute('data-light-route')),
    'the light-work route',
  );
  assert.equal(await panel.$eval('[data-light-route]', el => el.dataset.lightRoute), 'local');
  assert.match(await panel.$eval('[data-light-route]', el => el.innerText), /Ollama · qwen3\.8:8b/);

  // A workspace summary is light work: with something to summarise, it is written by the local model
  const now = Date.now();
  await panel.evaluate(
    item =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('kbItems', 'readwrite');
          tx.objectStore('kbItems').put(item);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    {
      id: 'page:light-1',
      sourceType: 'page',
      sourceId: 'https://example.com/light',
      title: 'A page to summarise',
      url: 'https://example.com/light',
      sourceDate: now,
      sourceUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
      chunkCount: 0,
      unembedded: 0,
      workspaceId: null,
    },
  );
  const before = models.seen.filter(request => request.path === '/v1/chat/completions').length;
  const reply = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'history_summarize', workspaceId: null, force: true, requestId: 'light' }),
  );
  assert.equal(reply.type, 'history_ok');
  const calls = models.seen.filter(request => request.path === '/v1/chat/completions').slice(before);
  assert.ok(calls.length >= 1, 'the local model was called');
  assert.equal(JSON.parse(calls[0].body).model, 'qwen3.8:8b');

  // Recorded as light work, free, with what the cloud model would have cost
  const event = await until(async () => {
    const rows = await readTable(options, 'usageEvents');
    return rows.find(row => row.light && row.providerId === 'ollama');
  }, 'a light usage event');
  assert.equal(event.costUsd, 0);
  assert.ok(event.savedUsd > 0, `saved ${event.savedUsd}`);
  await openTab(panel, 'Usage');
  await until(
    () => panel.evaluate(() => document.querySelector('[data-light-saved]') !== null),
    'the savings line in usage',
  );
  // Nothing told the user to start Ollama: it was running
  assert.equal((await readTable(options, 'inbox')).filter(item => item.source === 'models').length, 0);
  await panel.close();
});
