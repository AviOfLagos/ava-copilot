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
  await options.goto(`${extension.origin}/options.html`);
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

test('the open "Add New Provider" list is not clipped by the Model Selection card below it', async () => {
  // Regression test for the global stacking-context fix (src/ui/lib/theme.css): every card gets its
  // own stacking context from backdrop-filter, so without the fix a later sibling card always paints
  // over an earlier card's open dropdown, no matter the dropdown's own z-index.
  await options.bringToFront();
  await options.waitForSelector('[data-provider-menu-trigger]', { timeout: 10000 });
  await options.click('[data-provider-menu-trigger]');
  await options.waitForSelector('[data-provider-menu]', { timeout: 5000 });

  const geometry = await options.evaluate(() => {
    const trigger = document.querySelector('[data-provider-menu-trigger]');
    const menu = document.querySelector('[data-provider-menu]');
    const providersCard = trigger.closest('.rounded-lg.border');
    const nextCard = providersCard?.nextElementSibling ?? null;
    const menuRect = menu.getBoundingClientRect();
    const nextRect = nextCard?.getBoundingClientRect();
    if (!nextRect) return { overlaps: false, nextCardHeading: null };

    // The point in the middle of wherever the two boxes actually overlap: only reachable when the
    // dropdown really does extend past its own card and over the next one (the bug this proves fixed).
    const top = Math.max(menuRect.top, nextRect.top);
    const bottom = Math.min(menuRect.bottom, nextRect.bottom);
    const left = Math.max(menuRect.left, nextRect.left);
    const right = Math.min(menuRect.right, nextRect.right);
    const overlaps = bottom > top && right > left;
    if (!overlaps) return { overlaps, nextCardHeading: nextCard.querySelector('h2')?.textContent ?? null };

    const x = Math.round((left + right) / 2);
    const y = Math.round((top + bottom) / 2);
    const topElement = document.elementFromPoint(x, y);
    return {
      overlaps,
      x,
      y,
      nextCardHeading: nextCard.querySelector('h2')?.textContent ?? null,
      topIsMenu: Boolean(topElement && menu.contains(topElement)),
      topElementHtml: topElement?.outerHTML?.slice(0, 160) ?? null,
    };
  });

  assert.equal(geometry.nextCardHeading, 'Model Selection');
  assert.ok(
    geometry.overlaps,
    `the open dropdown must extend past the Providers card and over "Model Selection" for this test to ` +
      `prove anything; it does not currently (geometry: ${JSON.stringify(geometry)})`,
  );
  assert.ok(
    geometry.topIsMenu,
    `document.elementFromPoint at (${geometry.x}, ${geometry.y}), where the dropdown overlaps the next ` +
      `card, hit the card instead of the dropdown: ${geometry.topElementHtml}`,
  );

  // Leave the page as the next test expects it
  await options.click('[data-provider-menu-trigger]');
});

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
  assert.equal(await options.$eval('#nvidia-api-key', el => el.value), '', 'the key field starts empty');

  const saveWithKey = async key => {
    await options.click('#nvidia-api-key', { clickCount: 3 });
    await options.type('#nvidia-api-key', key);
    await options.evaluate(card => {
      [...document.querySelectorAll(`${card} button`)].find(button => button.innerText.trim() === 'Save').click();
    }, card);
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

test('the Models & usage page in the panel lists providers, models and usage', async () => {
  const panel = await extension.browser.newPage();
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.waitForSelector('textarea');
  await panel.bringToFront();

  // Reached from the drawer: its list, or the profile menu at its foot
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
  await until(
    () =>
      panel.evaluate(() => Number(document.querySelector('[data-usage-total]')?.getAttribute('data-usage-total')) > 0),
    'usage in the panel',
  );
  const text = await panel.evaluate(() => document.body.innerText);
  assert.ok(!text.includes(NVIDIA_KEY_2) && !text.includes(OPENROUTER_KEY), 'no key in the panel');
  await panel.close();
});
