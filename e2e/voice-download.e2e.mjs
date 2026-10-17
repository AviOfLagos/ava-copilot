import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { COMPONENTS } from '../scripts/voice-models-setup.mjs';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end test of the voice models downloaded on first use, in a build with none packed (no public/voice or
 * public/wake): Talk with nothing downloaded shows the download card, its progress, a cancel that keeps what was
 * fetched (the next try resumes with a Range request), then the conversation runs on the device (Moonshine hears,
 * a scripted text model answers, KittenTTS speaks); a reload keeps the files. Turning the wake word on downloads its
 * model the same way, and "Hey Ava" then starts a conversation.
 *
 * Nothing comes from Hugging Face: the files are served from 127.0.0.1, made from a checkout's own models
 * (VOICE_MODELS_SOURCE, default ./public; from `node scripts/voice-models-setup.mjs` and `wake-word-setup.mjs`), and
 * handed to the panel as a test catalog (loopback only, see activeCatalog). Moonshine's and KittenTTS's model files
 * keep their pinned sums; voices.npz and the Vosk zip are rebuilt here, so they get sums of their own.
 */

const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(process.env.VOICE_MODELS_SOURCE ?? path.join(root, 'public'));
const packed = ['voice', 'wake'].filter(dir => fs.existsSync(path.join(root, 'dist', dir)));
const SKIP = packed.length
  ? `this build packs ${packed.join(' and ')}: build without public/voice and public/wake`
  : !fs.existsSync(path.join(source, 'voice/kitten/voices.json')) ||
      !fs.existsSync(path.join(source, 'voice/moonshine-tiny/config.json'))
    ? `no models to serve in ${source}: set VOICE_MODELS_SOURCE to a public/ folder made by the setup scripts`
    : false;
if (SKIP) console.log(`# voice-download skipped: ${SKIP}`);
const WAKE = !SKIP && fs.existsSync(path.join(source, 'wake/model.tar.gz'));

process.env.E2E_FAKE_MIC = '1';
// "Hey Ava, what is on my calendar today?" on a loop as the microphone
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** A stored zip archive, as numpy.savez writes voices.npz. */
function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, data);
    central.push(record, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** A float32 .npy array with the shape the KittenTTS voices have. */
function npy(shape, data) {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(', ')}), }`;
  header += ' '.repeat(63 - ((10 + header.length) % 64)) + '\n';
  const prefix = Buffer.alloc(10);
  prefix.set([0x93, ...Buffer.from('NUMPY'), 1, 0]);
  prefix.writeUInt16LE(header.length, 8);
  return Buffer.concat([prefix, Buffer.from(header, 'latin1'), data]);
}

let work;
let files; // url path → absolute file
let catalog;
let server;
let slow = false;
const fileRequests = [];

/** The served copies and the test catalog pointing at them. */
function prepare(port) {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-download-'));
  files = new Map();
  const base = `http://127.0.0.1:${port}`;
  const entry = (id, filePath, absolute, pinned) => {
    const bytes = fs.readFileSync(absolute);
    if (pinned) assert.equal(sha256(bytes), pinned, `${id}/${filePath} is the pinned file`);
    files.set(`/${id}/${filePath}`, absolute);
    return { path: filePath, url: `${base}/${id}/${filePath}`, bytes: bytes.length, sha256: sha256(bytes) };
  };
  const moonshine = Object.entries(COMPONENTS['moonshine-tiny'].files).map(([target, [, , , pinned]]) =>
    entry('moonshine-tiny', target, path.join(source, 'voice/moonshine-tiny', target), pinned),
  );
  // voices.npz is unpacked by the setup script and not kept: made again from the raw voices
  const voices = JSON.parse(fs.readFileSync(path.join(source, 'voice/kitten/voices.json'), 'utf8'));
  const npz = storedZip(
    Object.values(voices.voices).map(({ key }) => ({
      name: `${key}.npy`,
      data: npy(
        [voices.styles, voices.styleDim],
        fs.readFileSync(path.join(source, 'voice/kitten/voices', `${key}.bin`)),
      ),
    })),
  );
  fs.writeFileSync(path.join(work, 'voices.npz'), npz);
  const kitten = Object.entries(COMPONENTS.kitten.files).map(([target, [, , , pinned]]) =>
    target === 'voices.npz'
      ? entry('kitten', target, path.join(work, 'voices.npz'))
      : entry('kitten', target, path.join(source, 'voice/kitten', target), pinned),
  );
  catalog = {
    'moonshine-tiny': { id: 'moonshine-tiny', files: moonshine },
    kitten: { id: 'kitten', unpack: 'kitten-voices', files: kitten },
  };
  if (WAKE) {
    // The packed model.tar.gz, as the zip alphacephei.com serves
    execFileSync('tar', ['xzf', path.join(source, 'wake/model.tar.gz')], { cwd: work });
    execFileSync('zip', ['-q', '-r', 'model.zip', 'vosk-model-small-en-us-0.15'], { cwd: work });
    catalog.vosk = {
      id: 'vosk',
      unpack: 'vosk-model',
      files: [entry('vosk', 'model.zip', path.join(work, 'model.zip'))],
    };
  }
}

/** Serves the model files with Range support; slow mode sends them in small, spaced chunks. */
async function startFileServer() {
  server = http.createServer(async (req, res) => {
    const file = files?.get(new URL(req.url, 'http://x').pathname);
    fileRequests.push({ url: req.url, range: req.headers.range ?? null });
    if (!file) return res.writeHead(404).end();
    const size = fs.statSync(file).size;
    const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
    res.writeHead(start ? 206 : 200, {
      'Content-Length': size - start,
      'Accept-Ranges': 'bytes',
      ...(start ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}),
    });
    const stream = fs.createReadStream(file, { start, highWaterMark: slow ? 256 * 1024 : 4 * 1024 * 1024 });
    for await (const chunk of stream) {
      if (res.destroyed) break;
      res.write(chunk);
      if (slow) await sleep(40);
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

/** The conversation's text model: answers anything heard with a short sentence; ends when allowed. */
async function startTextModel() {
  const requests = [];
  let allowEnd = false;
  const http2 = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'voice-script', object: 'model' }] }));
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const message = allowEnd
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: `end_${requests.length}`, type: 'function', function: { name: 'end_conversation', arguments: '{}' } },
          ],
        }
      : { role: 'assistant', content: request.messages.at(-1).role === 'tool' ? 'Done.' : 'All clear today.' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-voice',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise(resolve => http2.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${http2.address().port}/v1`,
    requests,
    end: value => {
      allowEnd = value;
    },
    close: () => new Promise(resolve => http2.close(resolve)),
  };
}

const waitFor = async (check, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  const shown = session ? await session.panelText().catch(() => '') : '';
  throw new Error(
    `Timed out waiting for ${typeof label === 'function' ? label() : label}\nPanel: ${shown.slice(0, 600)}\nLogs:\n${logs.slice(-25).join('\n')}`,
  );
};

// What the offscreen document, its workers and the background print, and every CSP violation, for failures
const logs = [];
const violations = [];
const watched = new Set();
async function watchTargets() {
  for (const target of extension?.browser.targets() ?? []) {
    const url = target.url();
    if (watched.has(target) || !url.startsWith(extension.origin)) continue;
    if (!url.endsWith('/offscreen.html') && !['other', 'worker', 'service_worker'].includes(target.type())) continue;
    watched.add(target);
    try {
      const cdp = await target.createCDPSession();
      const name = url.split('/').pop();
      cdp.on('Runtime.consoleAPICalled', event => {
        const text = event.args.map(arg => arg.value ?? arg.description ?? '').join(' ');
        logs.push(`[${name}] ${event.type}: ${text.slice(0, 300)}`);
        if (/Content Security Policy|Refused to/i.test(text)) violations.push(text);
      });
      cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
        logs.push(`[${name}] exception: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
      );
      cdp.on('Log.entryAdded', ({ entry }) => {
        if (entry.source === 'security' || /Content Security Policy/i.test(entry.text)) violations.push(entry.text);
      });
      await cdp.send('Log.enable').catch(() => {});
      await cdp.send('Runtime.enable');
    } catch {
      // Ended before it could be followed
    }
  }
}
let watcher;

/** A panel command with a reply, the way the panel's PanelApi sends one. */
function command(page, message, timeout = 60_000) {
  return page.evaluate(
    (message, timeout) =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'side-panel-connection' });
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => reject(new Error(`${message.type} timed out`)), timeout);
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
    timeout,
  );
}

/** What is in the extension's private file system under voice-models/<id>. */
const opfsListing = (page, id) =>
  page.evaluate(async id => {
    const names = [];
    const walk = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') await walk(handle, `${prefix}${name}/`);
        else names.push(`${prefix}${name}`);
      }
    };
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('voice-models');
      await walk(await root.getDirectoryHandle(id), '');
    } catch {
      // Nothing there
    }
    return names.sort();
  }, id);

const cardText = page =>
  page.evaluate(() => document.querySelector('[data-testid="voice-models-card"]')?.innerText ?? '');
const voiceRunning = page =>
  page
    .evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'voice_running' }))
    .then(reply => Boolean(reply?.running))
    .catch(() => false);

let mock;
let textModel;
let extension;
let session;
const outside = [];
let lastRuntime = null;

async function openPanel() {
  const { panel } = session;
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.waitForSelector('textarea');
  await panel.evaluate(catalog => {
    window.__nexVoiceModelsCatalog = catalog;
  }, catalog);
  await panel.bringToFront();
}

async function endConversation() {
  textModel.end(true);
  await waitFor(async () => !(await voiceRunning(session.panel)), 'the conversation to end', 60_000);
  textModel.end(false);
}

before(async () => {
  if (SKIP) return;
  prepare(await startFileServer());
  mock = await startMockLlm({});
  textModel = await startTextModel();
  extension = await launchExtension(mock);
  watcher = setInterval(() => void watchTargets(), 100);
  const providers = await extension.getStorage('llm-api-keys');
  await extension.setStorage({
    'llm-api-keys': {
      providers: {
        ...providers.providers,
        voicetext: {
          name: 'voicetext',
          type: 'custom_openai',
          apiKey: 'test',
          baseUrl: textModel.baseUrl,
          modelNames: ['voice-script'],
          createdAt: Date.now(),
        },
      },
    },
    'model-settings': { roles: { fast: { providerId: 'voicetext', model: 'voice-script' } } },
    'meeting-settings': { autoNotes: false, wakeWord: false },
  });
  session = await openSession(extension, mock);
  session.panel.on('request', request => {
    if (!/^(chrome-extension:|data:|blob:|http:\/\/127\.0\.0\.1[:/])/.test(request.url())) outside.push(request.url());
  });
  await openPanel();
});

after(async () => {
  clearInterval(watcher);
  await session?.close().catch(() => {});
  await extension?.close();
  await textModel?.close();
  await mock?.close();
  server?.close();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

test(
  'Talk with nothing downloaded: the card, its progress, cancel and resume, then a conversation on the device',
  { skip: SKIP },
  async () => {
    const { panel } = session;
    const status = await command(panel, { type: 'voice_engine_status' });
    assert.deepEqual(status.installed, {}, 'nothing packed, nothing downloaded');

    // The first Talk offers the download instead of an error
    await session.click('Talk to Ava');
    await panel.waitForSelector('[data-testid="voice-models-card"]', { timeout: 15_000 });
    assert.match(await cardText(panel), /Download voice \(≈60 MB, once\)/);
    assert.equal(await voiceRunning(panel), false, 'no conversation before the files are here');

    // Slowly, so it can be stopped part way: what came is kept
    slow = true;
    await session.click('Download');
    await panel.waitForSelector('[role="progressbar"]', { timeout: 10_000 });
    await waitFor(
      async () => {
        const percent = Number(/· (\d+)%/.exec(await cardText(panel))?.[1] ?? 0);
        // Inside the largest file (Moonshine's decoder, 20 MB), not between two
        return percent >= 30;
      },
      'some progress',
      60_000,
    );
    assert.match(await cardText(panel), /\d+ of 60 MB · \d+%/);
    await session.click('Cancel');
    await waitFor(async () => !(await cardText(panel)), 'the card to close');
    assert.equal(await voiceRunning(panel), false, 'cancelled: no conversation');
    const partial = [...(await opfsListing(panel, 'moonshine-tiny')), ...(await opfsListing(panel, 'kitten'))];
    assert.ok(partial.length > 0, 'what was fetched is kept');
    assert.ok(!partial.includes('.ready.json'), 'nothing is marked ready');

    // Talk again: the download goes on where it stopped, and the conversation starts by itself
    slow = false;
    const requestsBefore = fileRequests.length;
    await session.click('Talk to Ava');
    await panel.waitForSelector('[data-testid="voice-models-card"]', { timeout: 15_000 });
    await session.click('Download');
    await waitFor(async () => !(await cardText(panel)), 'the download to finish', 180_000);
    assert.ok(
      fileRequests.slice(requestsBefore).some(request => request.range && /^bytes=[1-9]\d*-$/.test(request.range)),
      'a partly downloaded file was resumed with a Range request',
    );

    await waitFor(() => textModel.requests.length >= 1, 'the text model to hear the question', 120_000);
    const heard = textModel.requests
      .flatMap(request => request.messages.filter(message => message.role === 'user').map(message => message.content))
      .join(' ');
    assert.match(heard, /calendar|ava/i, 'Moonshine, downloaded, wrote down what was said');
    await waitFor(
      async () => {
        const status = await command(panel, { type: 'voice_engine_status' });
        const { runtime } = status;
        lastRuntime = { ...status, sizesMb: undefined };
        return runtime?.tts.engine === 'kitten' && runtime.tts.requests > 0 && runtime.tts.peakRms > 0.01;
      },
      () => `KittenTTS, downloaded, to speak the answer (runtime: ${JSON.stringify(lastRuntime)})`,
      90_000,
    );
    assert.equal(mock.live.sessions.length, 0, 'no Live session');

    // Unpacked as the runtime reads it, the archive gone, both ready
    const kittenFiles = await opfsListing(panel, 'kitten');
    assert.ok(kittenFiles.includes('.ready.json') && kittenFiles.includes('voices.json'));
    assert.ok(kittenFiles.includes('voices/expr-voice-2-f.bin') && kittenFiles.includes('config.json'));
    assert.ok(!kittenFiles.includes('voices.npz') && !kittenFiles.some(name => name.endsWith('.part')));
    assert.ok((await opfsListing(panel, 'moonshine-tiny')).includes('.ready.json'));
    assert.deepEqual(outside, [], 'nothing fetched from anywhere but this computer');
    assert.deepEqual(violations, [], 'no CSP violation');
    await endConversation();
  },
);

test('a reload keeps the files: Talk starts at once, and Settings shows them downloaded', { skip: SKIP }, async () => {
  const { panel } = session;
  await openPanel();
  const before = textModel.requests.length;
  const served = fileRequests.length;
  await session.click('Talk to Ava');
  await waitFor(() => textModel.requests.length > before, 'the conversation to run', 120_000);
  assert.equal(await cardText(panel), '', 'no download card');
  assert.equal(fileRequests.length, served, 'nothing downloaded again');
  await endConversation();

  await session.click('Menu');
  await session.openAccountMenu();
  await session.click('Settings');
  await panel.waitForSelector('[data-testid="voice-model-kitten-state"]', { timeout: 15_000 });
  const state = id =>
    panel.evaluate(id => document.querySelector(`[data-testid="voice-model-${id}-state"]`)?.textContent, id);
  // The rows fill in once the background has answered
  await waitFor(async () => /^Downloaded/.test((await state('kitten')) ?? ''), 'the status to arrive', 15_000);
  assert.match(await state('kitten'), /^Downloaded · \d+ MB$/);
  assert.match(await state('moonshine-tiny'), /^Downloaded · \d+ MB$/);
  assert.match(await state('kokoro'), /^Not downloaded · about 97 MB$/);
  assert.doesNotMatch(await panel.evaluate(() => document.body.innerText), /node scripts\//, 'no developer command');
});

test(
  'turning the wake word on downloads its model, then "Hey Ava" starts a conversation',
  { skip: SKIP || !WAKE },
  async () => {
    const { panel } = session;
    await openPanel();
    await session.click('Menu');
    await session.openAccountMenu();
    await session.click('Settings');
    const wakeSwitch = await panel.waitForSelector('button[role="switch"][aria-label^="Listen for"]', {
      timeout: 15_000,
    });
    await wakeSwitch.click();
    await panel.waitForSelector('[data-testid="voice-models-card"]', { timeout: 15_000 });
    assert.match(await cardText(panel), /Download the wake word \(≈\d+ MB, once\)/);
    const before = textModel.requests.length;
    await session.click('Download');
    await waitFor(async () => !(await cardText(panel)), 'the wake model to download', 180_000);
    const vosk = await opfsListing(panel, 'vosk');
    assert.deepEqual(vosk, ['.ready.json', 'model.tar.gz', 'words.txt']);
    assert.equal((await extension.getStorage('meeting-settings'))?.wakeWord, true);
    // The recording says "Hey Ava, what is on my calendar today?": a conversation starts on the device
    await waitFor(async () => textModel.requests.length > before, '"Hey Ava" to start a conversation', 120_000);
    await endConversation();
    await extension.setStorage({ 'meeting-settings': { autoNotes: false, wakeWord: false } });
  },
);
