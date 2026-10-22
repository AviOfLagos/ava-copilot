import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startMockLlm, startMockOllama } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end test of local models only, and the setup checklist. The only model is Ollama (a stand-in on its own
 * port, so a real Ollama on 11434 does not matter) with qwen3:4b and nomic-embed-text; there is no cloud key at all.
 * A browser task runs to the end on it; the checklist (Settings › General › Setup) reads the local model as ready and
 * sets it for light work and the fallback; the header's count and the toolbar badge follow what is owed, and Skip
 * takes a recommended step off them and brings it back. E2E_SHOTS=<dir> saves screenshots.
 */

const PORT = 11593;
const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];

async function until(check, what, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}. Last: ${JSON.stringify(last)?.slice(0, 400)}`);
}

async function shot(page, name) {
  if (!process.env.E2E_SHOTS) return;
  await page.bringToFront();
  await sleep(300);
  await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `setup-${name}.png`), fullPage: true });
}

let mock;
let ollama;
let extension;

before(async () => {
  mock = await startMockLlm({ 'local-only': [done] });
  ollama = await startMockOllama(mock, { port: PORT, models: ['qwen3:4b', 'nomic-embed-text'] });
  // No model from the harness: Ollama is the only provider
  extension = await launchExtension(mock, { model: false });
  const agent = { provider: 'ollama', modelName: 'qwen3:4b' };
  await extension.setStorage({
    'llm-api-keys': {
      providers: {
        ollama: {
          name: 'Ollama',
          type: 'ollama',
          apiKey: 'ollama',
          baseUrl: `http://127.0.0.1:${PORT}/v1`,
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
  await mock?.close();
});

test('with only Ollama and no cloud key, a browser task runs to the end on qwen3:4b', async () => {
  mock.start('local-only');
  const session = await openSession(extension, mock);
  await session.send('Run the scripted scenario local-only.');
  const text = await session.waitForEnd(90000);
  assert.match(text, /E2E scenario finished/);
  const run = mock.runs.get('local-only');
  assert.ok(run.navigatorCalls.length > 0, 'the navigator was answered through Ollama');
  assert.deepEqual(run.errors, []);
  await session.close();
});

test('the setup checklist reads the real status, sets the local model, and Skip changes the count', async () => {
  const page = await extension.openSettings('#general/setup', { width: 420, height: 1600 });
  await page.bringToFront();
  const item = id =>
    page.evaluate(id => {
      const row = document.querySelector(`[data-setup-item="${id}"]`);
      return row
        ? {
            ready: row.getAttribute('data-ready'),
            skipped: row.getAttribute('data-skipped'),
            line: row.querySelector('[data-setup-line]')?.textContent ?? '',
          }
        : null;
    }, id);

  await until(async () => (await item('local'))?.ready === 'true', 'the local model ready');
  assert.match((await item('local')).line, /qwen3:4b/);
  assert.equal((await item('model')).ready, 'true', 'a working model (local)');
  // Not paired here: Nex Brain is owed, and what runs on it says it waits for it
  assert.equal((await item('brain')).ready, 'false');
  assert.match((await item('whatsapp')).line, /Nex Brain/);
  await shot(page, '1-checklist');

  // Once present, it does light work and finishes failed cloud calls
  const settings = await until(async () => {
    const value = await extension.getStorage('model-settings');
    return value?.roles?.local && value?.fallbackLocal?.model ? value : null;
  }, 'the local model set for light work and the fallback');
  assert.deepEqual(settings.roles.local, { providerId: 'ollama', model: 'qwen3:4b' });
  assert.deepEqual(settings.fallbackLocal.model, { providerId: 'ollama', model: 'qwen3:4b' });

  const pending = async () => (await extension.getStorage('setup-state'))?.pending ?? null;
  const before = await until(pending, 'a count');
  assert.ok(before >= 6, `brain, and the five recommended steps, are owed (got ${before})`);
  const badge = () => page.evaluate(() => chrome.action.getBadgeText({}));
  await until(async () => (await badge()) === String(before), 'the toolbar badge with the count');

  // The side panel's header shows the same count, and its button leads here
  const panel = await extension.browser.newPage();
  await panel.setViewport({ width: 400, height: 760 });
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.bringToFront();
  const shown = await until(
    () => panel.evaluate(() => document.querySelector('[data-testid="setup-indicator"]')?.getAttribute('data-pending')),
    'the header indicator',
  );
  assert.equal(shown, String(before));
  await shot(panel, '2-indicator');

  // Skip a recommended step: off the count, still in the list
  await page.bringToFront();
  await extension.clickOn(page, 'Skip WhatsApp linked');
  await until(async () => (await pending()) === before - 1, 'the count without WhatsApp');
  await until(async () => (await item('whatsapp'))?.skipped === 'true', 'WhatsApp shown as skipped');
  await until(async () => (await badge()) === String(before - 1), 'the badge without WhatsApp');
  await until(
    () =>
      panel.evaluate(
        n => document.querySelector('[data-testid="setup-indicator"]')?.getAttribute('data-pending') === n,
        String(before - 1),
      ),
    'the header count without WhatsApp',
  );
  // A required step has no Skip
  assert.equal(
    await page.evaluate(() => Boolean(document.querySelector('[data-setup-item="brain"] button[aria-label^="Skip"]'))),
    false,
  );
  await shot(page, '3-skipped');

  await extension.clickOn(page, 'Bring back WhatsApp linked');
  await until(async () => (await pending()) === before, 'the count with WhatsApp again');
  await panel.close();
  await page.close();
});

test("Settings › Meetings shows Ava's meeting account and the join choice, off by default", async () => {
  const page = await extension.openSettings('#meetings/ava', { width: 420, height: 1200 });
  await page.waitForSelector('[data-testid="ava-account"]', { timeout: 10000 });
  const text = await page.evaluate(() => document.querySelector('[data-testid="ava-account"]').innerText);
  assert.match(text, /You sign in yourself/);
  assert.match(text, /Pair Nex Brain first/);
  assert.equal(await page.$eval('#meetvoice-auto', select => select.value), 'never');
  await page.select('#meetvoice-auto', 'ask');
  await until(async () => (await extension.getStorage('meet-voice-settings'))?.autoJoin === 'ask', 'the choice saved');
  await shot(page, '4-ava');
  await page.close();
});
