import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { startMockLlm, startMockOllama } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end test of the full-page Settings and install-before-use: every page opens from the nav and draws every
 * section registered for it (one control per page is used and its setting checked in storage); `#voice/engines`
 * lands on that section and back/forward walk the pages; the search finds a setting on another page; the side
 * panel's quick settings change what they say and "more" opens the full page at the right place; choosing Kokoro
 * (not installed) shows Install and saves only after the (mock) download; a recommended local model installs through
 * a mock Ollama's /api/pull with its progress. E2E_SHOTS=<dir> saves every page at 1280 and 400 px.
 */

const PAGES = ['general', 'models', 'voice', 'personalities', 'memory', 'connections', 'meetings', 'privacy', 'help'];

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

const waitFor = async (check, what, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const text = page => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));

async function shot(page, name) {
  if (!process.env.E2E_SHOTS) return;
  await page.bringToFront();
  await sleep(300);
  await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `settings-${name}.png`), fullPage: true });
}

/** Clicks the first button (or link) whose text or label is `label`, inside `scope` when given. */
const click = (page, label, scope = 'body') =>
  page.evaluate(
    (label, scope) => {
      const root = document.querySelector(scope);
      const target = [...root.querySelectorAll('button, a, [role="radio"], [role="switch"]')].find(element => {
        const said = element.innerText.trim();
        return said === label || element.getAttribute('aria-label') === label;
      });
      if (!target) throw new Error(`Nothing to click called "${label}" in ${scope}`);
      target.click();
    },
    label,
    scope,
  );

/** Sets a select's value as a person choosing it does. */
const choose = (page, selector, value) =>
  page.evaluate(
    (selector, value) => {
      const select = document.querySelector(selector);
      if (!select) throw new Error(`No select ${selector}`);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    },
    selector,
    value,
  );

const section = id => `[data-settings-section="${id}"]`;

test('every page opens from the nav and draws its sections; one control per page works', async () => {
  const page = await extension.openSettings('');
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const nav = await page.$$eval('nav [data-settings-page]', links => links.map(link => link.dataset.settingsPage));
  assert.deepEqual(nav, PAGES, 'the nav lists the pages, in order');

  const seen = {};
  for (const id of PAGES) {
    await page.click(`nav [data-settings-page="${id}"]`);
    await page.waitForFunction(id => location.hash === `#${id}`, { polling: 100 }, id);
    await page.waitForSelector('[data-settings-section]');
    await sleep(400);
    seen[id] = await page.$$eval('[data-settings-section]', sections =>
      sections.map(item => item.dataset.settingsSection),
    );
    assert.ok(seen[id].length > 0, `${id} has sections`);
    assert.doesNotMatch(await text(page), /could not be shown/, `every section on ${id} draws`);
    await shot(page, `${id}-1280`);
  }
  assert.deepEqual(seen.voice, ['voice-identity', 'tts', 'voice-engines', 'audio-devices', 'wake']);
  assert.deepEqual(seen.general, ['names', 'theme', 'writing', 'confirm', 'cap', 'highlights', 'agent']);
  assert.deepEqual(seen.memory, [
    'about-you',
    'history',
    'memory-index',
    'memory-agents',
    'memory-backups',
    'memory-data',
  ]);
  assert.deepEqual(seen.connections, ['connectors', 'obsidian', 'calendar', 'brain']);
  assert.deepEqual(seen.meetings, ['meetings', 'brief', 'inbox']);
  assert.deepEqual(seen.privacy, ['firewall', 'skills']);
  assert.deepEqual(seen.help, ['help-install', 'help-tasks']);
  assert.deepEqual(seen.models, ['models']);
  assert.deepEqual(seen.personalities, ['personalities']);

  // General: show what it clicks
  await page.goto(`${extension.origin}/options.html#general`);
  await page.waitForSelector(section('highlights'));
  await click(page, 'Show what it clicks', section('highlights'));
  await waitFor(
    async () => (await extension.getStorage('general-settings'))?.displayHighlights === true,
    'highlights on',
  );
  // And a limit of the browser agent, kept as the old settings page kept it
  await page.evaluate(() => {
    const input = document.querySelector('#settings-maxSteps');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '33');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitFor(async () => (await extension.getStorage('general-settings'))?.maxSteps === 33, 'max steps saved');

  // Models: the Models page, through the settings port
  await page.goto(`${extension.origin}/options.html#models`);
  await page.waitForSelector('[data-place="models"] [data-models-summary]');
  await waitFor(async () => /mock|scripted|active/i.test(await text(page)), 'the models summary');

  // Voice: the conversation mode
  await page.goto(`${extension.origin}/options.html#voice`);
  await page.waitForSelector('#voice-engine-mode');
  await choose(page, '#voice-engine-mode', 'economy');
  await waitFor(async () => (await extension.getStorage('voice-engine-settings'))?.mode === 'economy', 'economy mode');

  // Personalities: the list draws with the built-ins
  await page.goto(`${extension.origin}/options.html#personalities`);
  await page.waitForSelector('[aria-label="All personalities"]', { timeout: 10000 });

  // Memory: chats stop joining memory
  await page.goto(`${extension.origin}/options.html#memory`);
  await page.waitForSelector(section('memory-index'));
  const indexChats = await page.$eval(`${section('memory-index')} [role="switch"]`, el =>
    el.getAttribute('aria-label'),
  );
  await click(page, indexChats, section('memory-index'));
  await waitFor(async () => (await extension.getStorage('kb-settings'))?.indexChats === false, 'chats left out');

  // Connections: reminders ten minutes before meetings
  await page.goto(`${extension.origin}/options.html#connections`);
  await page.waitForSelector(`${section('calendar')} select`);
  await choose(page, `${section('calendar')} select`, '10');
  await waitFor(async () => (await extension.getStorage('calendar-settings'))?.remindMinutes === 10, 'reminders saved');

  // Meetings: keep the audio
  await page.goto(`${extension.origin}/options.html#meetings`);
  await page.waitForSelector(section('meetings'));
  await click(page, 'Keep meeting audio', section('meetings')).catch(async () => {
    const labels = await page.$$eval(`${section('meetings')} [role="switch"]`, items =>
      items.map(i => i.getAttribute('aria-label')),
    );
    await click(page, labels.at(-1), section('meetings'));
  });
  await waitFor(async () => (await extension.getStorage('meeting-settings'))?.keepAudio === true, 'audio kept');

  // Privacy: the firewall's field is there
  await page.goto(`${extension.origin}/options.html#privacy`);
  await page.waitForSelector(`${section('firewall')} input`);

  // Help: what needs installing, and how-do-I
  await page.goto(`${extension.origin}/options.html#help`);
  await page.waitForSelector('[data-installable="obsidian"]');
  await page.waitForSelector(`${section('help-tasks')} input[type="search"]`);

  assert.deepEqual(errors, []);
  await page.close();
});

test('#voice/engines lands on that section; back and forward walk the pages; search finds across pages', async () => {
  const page = await extension.openSettings('#voice/engines');
  await page.waitForSelector(section('voice-engines'));
  await waitFor(
    () =>
      page.evaluate(() => {
        const box = document.getElementById('settings-voice-engines')?.getBoundingClientRect();
        return Boolean(box && box.top >= 0 && box.top < 200 && document.activeElement?.id === 'settings-voice-engines');
      }),
    'the engines section scrolled to the top, with focus',
  );
  assert.equal(await page.$eval('[data-settings-title]', el => el.textContent), 'Voice');

  await page.click('nav [data-settings-page="memory"]');
  await page.waitForFunction(() => location.hash === '#memory', { polling: 100 });
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#voice/engines', { polling: 100 });
  await page.waitForFunction(() => document.querySelector('[data-settings-title]')?.textContent === 'Voice', {
    polling: 100,
  });
  await page.goForward();
  await page.waitForFunction(() => document.querySelector('[data-settings-title]')?.textContent === 'Memory', {
    polling: 100,
  });

  // A tab of the Models page
  await page.goto(`${extension.origin}/options.html#models/local`);
  await page.waitForFunction(
    () => document.querySelector('#models-tab-local')?.getAttribute('aria-selected') === 'true',
    { polling: 100, timeout: 10000 },
  );

  // Search: "whisper" is on Voice, found from Models
  await page.type('input[type="search"]', 'whisper');
  await page.waitForFunction(() => /whisper/.test(document.querySelector('[data-settings-title]')?.textContent ?? ''), {
    polling: 100,
  });
  await page.waitForSelector(section('voice-engines'));
  assert.equal(await page.$(section('models')), null, 'the page’s own sections give way to the results');
  await page.evaluate(() => {
    const input = document.querySelector('input[type="search"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'zzzz nothing');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => /No setting matches/.test(document.body.innerText), { polling: 100 });
  await page.close();
});

test('narrow windows get the pages as chips, and every page still fits', async () => {
  const page = await extension.openSettings('#general', { width: 400, height: 860 });
  for (const id of PAGES) {
    await page.goto(`${extension.origin}/options.html#${id}`);
    await page.waitForSelector('[data-settings-section]');
    await sleep(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${id} does not scroll sideways at 400 px (by ${overflow})`);
    await shot(page, `${id}-400`);
  }
  await page.close();
});

test('the panel’s quick settings work, and "more" opens the full page at the right place', async () => {
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 860 });
  await session.click('Menu');
  await session.openAccountMenu();
  await session.click('Settings');
  await session.panel.waitForSelector('[data-quick-setting]');
  const quick = await session.panel.$$eval('[data-quick-setting]', items =>
    items.map(item => item.dataset.quickSetting),
  );
  assert.deepEqual(quick, ['#voice/wake', '#voice/tts', '#personalities', '#models', '#general/theme']);
  await shot(session.panel, 'panel-quick');

  // The look
  await click(session.panel, 'Light');
  await session.panel.waitForFunction(() => document.documentElement.dataset.theme === 'light', { polling: 100 });
  await click(session.panel, 'Dark');
  // Read aloud
  await choose(session.panel, '#quick-read-aloud', 'always');
  await waitFor(async () => (await extension.getStorage('tts-settings'))?.readAloud === 'always', 'read aloud saved');
  // The personality in force
  await choose(session.panel, '#quick-personality', 'engineer');
  await waitFor(
    async () => (await extension.getStorage('personalities'))?.activeId === 'engineer',
    'personality saved',
  );
  assert.match(await session.panelText(), /plans · .* acts/);

  // "More" about Voice engines' read-aloud: the Settings tab moves there
  await session.panel.$eval('[data-settings-more="#voice/tts"]', button => button.click());
  await waitFor(
    async () => (await extension.browser.pages()).some(item => item.url().endsWith('/options.html#voice/tts')),
    'the Settings tab at #voice/tts',
  );
  const settings = (await extension.browser.pages()).find(item => item.url().endsWith('/options.html#voice/tts'));
  await settings.waitForSelector(section('tts'));
  // All settings
  await session.panel.$eval('[data-all-settings]', button => button.click());
  await waitFor(async () => settings.url().endsWith('/options.html#general'), 'All settings at #general');
  await session.close();
});

/** Serves a small fake Kokoro, slowly, and the catalog that points the download at it. */
async function startKokoro() {
  const bytes = Buffer.alloc(600_000, 7);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/kokoro/config.json')) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
    for (let at = 0; at < bytes.length; at += 60_000) {
      res.write(bytes.subarray(at, at + 60_000));
      await sleep(120);
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const catalog = {
    kokoro: {
      id: 'kokoro',
      files: [{ path: 'config.json', url: `http://127.0.0.1:${port}/kokoro/config.json`, bytes: bytes.length, sha256 }],
    },
  };
  return { catalog, close: () => new Promise(resolve => server.close(resolve)) };
}

test('choosing Kokoro, not installed, shows Install and saves only after the download', async () => {
  const kokoro = await startKokoro();
  try {
    await extension.setStorage({
      'tts-settings': { readAloud: 'off', engine: 'system', engineChosen: true, voice: '', rate: 1 },
    });
    const page = await extension.openSettings('#voice/engines');
    await page.evaluate(catalog => {
      window.__nexVoiceModelsCatalog = catalog;
    }, kokoro.catalog);
    await page.waitForSelector('#voice-engine-tts');
    await page.waitForFunction(
      () =>
        /Kokoro.*Install/.test(document.querySelector('#voice-engine-tts option[value="kokoro"]')?.textContent ?? ''),
      { polling: 200, timeout: 10000 },
    );

    // Choose it, then Cancel: nothing changes
    await choose(page, '#voice-engine-tts', 'kokoro');
    const card = `${section('voice-engines')} [data-testid="requirement-card"]`;
    await page.waitForSelector(card, { timeout: 10000 });
    assert.match(await page.$eval(card, el => el.innerText), /Needs Kokoro/);
    assert.equal((await extension.getStorage('tts-settings')).engine, 'system', 'not saved while it is missing');
    assert.equal(await page.$eval('#voice-engine-tts', el => el.value), 'system', 'the select keeps the old choice');
    await shot(page, 'requirement-card');
    await click(page, 'Cancel', card);
    await page.waitForFunction(selector => !document.querySelector(selector), { polling: 100 }, card);
    assert.equal((await extension.getStorage('tts-settings')).engine, 'system');

    // Again, and Install: progress, then saved
    await choose(page, '#voice-engine-tts', 'kokoro');
    await page.waitForSelector(card);
    await click(page, 'Install', card);
    await page.waitForSelector(`${card} [data-testid="requirement-progress"]`, { timeout: 10000 });
    await shot(page, 'requirement-progress');
    assert.equal((await extension.getStorage('tts-settings')).engine, 'system', 'not saved mid-download');
    await waitFor(async () => (await extension.getStorage('tts-settings'))?.engine === 'kokoro', 'kokoro saved', 30000);
    await page.waitForFunction(selector => !document.querySelector(selector), { polling: 100 }, card);
    assert.equal(await page.$eval('#voice-engine-tts', el => el.value), 'kokoro');
    await page.close();
  } finally {
    await kokoro.close();
  }
});

const portFree = port =>
  new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(true));
  });

test('a recommended local model installs through Ollama’s pull, with its progress', async t => {
  if (!(await portFree(11434))) return t.skip('something already listens on 11434 (a real Ollama)');
  const ollama = await startMockOllama(mock, { models: ['nomic-embed-text'] });
  try {
    await extension.setStorage({ 'model-settings': { localMemoryGb: 16 } });
    const page = await extension.openSettings('#models/local');
    const row = '[data-ollama-install="qwen3:8b"]';
    await page.waitForSelector(`${row} button`, { timeout: 15000 });
    await click(page, 'Install qwen3:8b', row);
    await page.waitForSelector(`${row} [data-testid="requirement-card"]`, { timeout: 10000 });
    assert.match(await page.$eval(row, el => el.innerText), /Needs qwen3:8b/);
    await click(page, 'Install', `${row} [data-testid="requirement-card"]`);
    await page.waitForFunction(
      selector =>
        /\d+%/.test(document.querySelector(`${selector} [data-testid="requirement-progress"]`)?.textContent ?? ''),
      { polling: 100, timeout: 10000 },
      row,
    );
    await shot(page, 'ollama-pull');
    await page.waitForSelector('[data-recommendation="qwen3:8b"][data-installed="true"]', { timeout: 20000 });
    assert.deepEqual(ollama.pulls, ['qwen3:8b']);
    assert.ok(ollama.models.includes('qwen3:8b'));
    await page.close();
  } finally {
    await ollama.close();
  }
});
