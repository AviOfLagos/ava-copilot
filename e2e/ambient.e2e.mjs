import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launchExtension, sleep } from './harness.mjs';

/**
 * End-to-end test of ambient listening, A1 (docs/ambient-plan.md): with Settings › Ambient on "Listen only", a
 * recording played as the microphone is written down on the device by Moonshine and kept as an ambient session, with
 * no model called at all (nothing heard reaches the cloud, and Ava says nothing). The panel shows that she listens.
 * Off the record, nothing more is written down; back on the record, it is again. Needs the local voice models:
 * node scripts/voice-models-setup.mjs, then pnpm build.
 */

const root = path.resolve(import.meta.dirname, '..');
const manifest = (file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null))(
  path.join(root, 'dist/voice/manifest.json'),
);
const SKIP = !manifest?.components?.['moonshine-tiny']
  ? 'the build has no Moonshine model: run node scripts/voice-models-setup.mjs, then pnpm build'
  : false;
if (SKIP) console.log(`# ambient skipped: ${SKIP}`);

process.env.E2E_FAKE_MIC = '1';
// "Hey Ava, what is on my calendar today?" on a loop as the microphone (about 6 s)
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');

let extension;
let models;

/**
 * A model provider that only counts. Ambient listening must never send it anything: no completion, no embedding.
 * The model catalog's own GET /models listing is not a call with content, so only POSTs count.
 */
function startCountingModel() {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') requests.push(`${req.method} ${req.url}`);
    res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"no model in this test"}');
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        requests,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise(done => server.close(done)),
      }),
    ),
  );
}

/**
 * Every row of an object store in the extension's IndexedDB, or none while it does not exist yet. Never creates the
 * database and never holds it open: an empty one made here first, or a connection left open, would block the
 * extension's own upgrade.
 */
function readAll(page, store) {
  return page.evaluate(
    store =>
      new Promise(resolve => {
        const open = indexedDB.open('avi-copilot');
        // Not created yet: leave it to the extension
        open.onupgradeneeded = () => open.transaction.abort();
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve([]);
            return;
          }
          const all = db.transaction(store).objectStore(store).getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result);
          };
          all.onerror = () => {
            db.close();
            resolve([]);
          };
        };
      }),
    store,
  );
}

async function waitFor(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const ambientSettings = changes =>
  extension.setStorage({
    'ambient-settings': { mode: 'listen', offRecord: false, offRecordSince: null, cloudAllowed: false, ...changes },
  });

before(async () => {
  if (SKIP) return;
  models = await startCountingModel();
  extension = await launchExtension(models);
});

after(async () => {
  await extension?.close();
  await models?.close();
});

test('Listen only writes down what is said, on the device, and says nothing', { skip: SKIP }, async () => {
  await ambientSettings({});
  const utterances = await waitFor(
    async () => {
      const rows = await readAll(extension.options, 'ambientUtterances');
      return rows.some(row => /calendar/i.test(row.text)) && rows;
    },
    'an utterance about the calendar',
  );
  const sessions = await readAll(extension.options, 'ambientSessions');
  assert.ok(sessions.length >= 1, 'kept in a session');
  assert.ok(utterances.every(row => row.speaker === 'unknown'));
  // Nothing heard reached a model, and no conversation started (it would have called the text model)
  assert.deepEqual(models.requests, []);
  // Without the cloud permission, nothing joins the knowledge base
  const items = await readAll(extension.options, 'kbItems');
  assert.equal(items.filter(item => item.sourceType === 'ambient').length, 0);

  const panel = await extension.browser.newPage();
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.waitForSelector('[data-testid="ambient-indicator"][data-state="listen"]', { timeout: 15000 });
  await panel.close();
});

test('Off the record writes nothing down, until back on the record', { skip: SKIP }, async () => {
  await ambientSettings({ offRecord: true, offRecordSince: Date.now() });
  // Let an utterance already being written down land
  await sleep(4000);
  const before = (await readAll(extension.options, 'ambientUtterances')).length;
  const panel = await extension.browser.newPage();
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.waitForSelector('[data-testid="ambient-indicator"][data-state="off-record"]', { timeout: 15000 });
  // Three loops of the recording
  await sleep(18000);
  assert.equal((await readAll(extension.options, 'ambientUtterances')).length, before, 'nothing written off the record');

  await ambientSettings({ offRecord: false });
  await panel.waitForSelector('[data-testid="ambient-indicator"][data-state="listen"]', { timeout: 15000 });
  await waitFor(
    async () => (await readAll(extension.options, 'ambientUtterances')).length > before,
    'words written down again',
  );
  await panel.close();
  assert.deepEqual(models.requests, []);
});

test('Settings › Ambient shows the mode, and turning it off stops listening', { skip: SKIP }, async () => {
  const page = await extension.openSettings('#voice/ambient');
  await page.waitForSelector('#ambient-mode', { timeout: 15000 });
  assert.equal(await page.$eval('#ambient-mode', select => select.value), 'listen');
  await page.select('#ambient-mode', 'off');
  await waitFor(async () => (await extension.getStorage('ambient-settings'))?.mode === 'off', 'listening off');
  await sleep(4000);
  const count = (await readAll(extension.options, 'ambientUtterances')).length;
  await sleep(12000);
  assert.equal((await readAll(extension.options, 'ambientUtterances')).length, count, 'nothing written once off');
  await page.close();
});
