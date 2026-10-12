#!/usr/bin/env node
/**
 * Ava's narration, rendered offline with the app's own local voice: the extension's Kokoro worker
 * (src/offscreen/tts-local/tts.worker.ts, imported unchanged) runs in headless Brave; each line comes back as PCM,
 * is levelled, written as WAV and encoded to AAC in public/audio/<id>-<hash>.m4a. The list of files, their lengths
 * and the hash of what was said go to src/content/narration-audio.json, which the page reads.
 *
 *   node scripts/narrate.mjs              # lines whose words or voice changed, or whose file is missing
 *   node scripts/narrate.mjs --all        # every line again
 *   node scripts/narrate.mjs hero gate    # just these lines
 *   node scripts/narrate.mjs --check      # exit 1 when a line's audio is missing or out of date
 *   node scripts/narrate.mjs --listen     # also transcribe every recording with the app's own speech recogniser
 *                                         # (Whisper base, else Moonshine) and compare it with the line
 *
 * Needs, all local: the extension's dependencies (`pnpm install` at the repo root: transformers.js, kitten-tts-js
 * and Vite, which bundles the worker), the Kokoro model files (`node scripts/voice-models-setup.mjs --kokoro` at
 * the root, or VOICE_DIR=<a folder holding kokoro/>), a Chromium-family browser (CHROME_PATH) and afconvert
 * (macOS) or ffmpeg. Nothing is fetched from the network. Kokoro 82M is Apache-2.0; macOS system voices are not
 * used, because their licence does not allow published, commercial use.
 */
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lineHash } from './narration-hash.mjs';

const site = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(site, '..');
const work = join(site, '.narrate');
const audioDir = join(site, 'public', 'audio');
const narrationPath = join(site, 'src', 'content', 'narration.json');
const manifestPath = join(site, 'src', 'content', 'narration-audio.json');
const SAMPLE_RATE = 24_000;

const args = process.argv.slice(2);
const all = args.includes('--all');
const check = args.includes('--check');
const listen = args.includes('--listen');
const only = args.filter(arg => !arg.startsWith('--'));

const narration = JSON.parse(readFileSync(narrationPath, 'utf8'));
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { lines: {} };

const stale = narration.lines.filter(line => {
  const entry = manifest.lines?.[line.id];
  return (
    !entry ||
    entry.hash !== lineHash(line, narration.voice, narration.speed) ||
    !existsSync(join(site, 'public', entry.file))
  );
});

if (check) {
  if (stale.length) {
    console.error(`narrate: out of date: ${stale.map(line => line.id).join(', ')} (run node scripts/narrate.mjs)`);
    process.exit(1);
  }
  console.log('narrate: every line has current audio');
  process.exit(0);
}

const todo = all ? narration.lines : only.length ? narration.lines.filter(line => only.includes(line.id)) : stale;
if (!todo.length && !listen) {
  console.log('narrate: nothing to do (every line has current audio; --all renders them again, --listen checks them)');
  process.exit(0);
}

// ─── What it needs ──────────────────────────────────────────────────────────────────────────────────────────────

const fail = message => {
  console.error(`narrate: ${message}`);
  process.exit(1);
};

const voiceDir = resolve(process.env.VOICE_DIR ?? join(repo, 'public', 'voice'));
// Model files are looked for in VOICE_DIR first, then in the extension's own voice folder
const voiceDirs = [...new Set([voiceDir, join(repo, 'public', 'voice')])];
const recogniser = ['whisper-base', 'moonshine-base', 'moonshine-tiny'].find(model =>
  voiceDirs.some(dir => existsSync(join(dir, model, 'config.json'))),
);
if (listen && !recogniser)
  fail('no speech recogniser to listen with: run `node scripts/voice-models-setup.mjs --whisper` at the repo root');
for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) {
  if (!existsSync(join(voiceDir, 'kokoro', file)))
    fail(
      `Kokoro is not in ${voiceDir}/kokoro (${file} is missing). Run \`node scripts/voice-models-setup.mjs --kokoro\` at the repo root, or set VOICE_DIR.`,
    );
}
if (!existsSync(join(voiceDir, 'kokoro', 'voices', `${narration.voice}.bin`)))
  fail(`the voice ${narration.voice} is not in ${voiceDir}/kokoro/voices`);

let vitePath;
try {
  vitePath = join(
    dirname(createRequire(join(repo, 'package.json')).resolve('vite/package.json')),
    'dist/node/index.js',
  );
} catch {
  fail('Vite is missing: install the extension’s dependencies first (`pnpm install` at the repo root)');
}
for (const name of ['@huggingface/transformers', 'kitten-tts-js']) {
  if (!existsSync(join(repo, 'node_modules', name)))
    fail(`${name} is missing: install the extension’s dependencies first (pnpm install at the repo root)`);
}

const BROWSERS = [
  process.env.CHROME_PATH,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  join(homedir(), 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/brave-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];
const executablePath = BROWSERS.find(path => path && existsSync(path));
if (!executablePath) fail('no Chromium-family browser found; set CHROME_PATH');

const has = command => spawnSync('which', [command]).status === 0;
const encoder = has('afconvert') ? 'afconvert' : has('ffmpeg') ? 'ffmpeg' : null;
if (!encoder) fail('no AAC encoder: afconvert (macOS) or ffmpeg is needed');

// ─── A page that runs the app's voice worker ───────────────────────────────────────────────────────────────────

rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'src'), { recursive: true });
writeFileSync(
  join(work, 'src', 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>narrate</title><script type="module" src="./main.js"></script>\n',
);
// The worker is the extension's, unchanged: the same text handling, phonemes and model call the panel uses
writeFileSync(
  join(work, 'src', 'main.js'),
  `const worker = new Worker(new URL('../../../src/offscreen/tts-local/tts.worker.ts', import.meta.url), { type: 'module' });
const pending = new Map();
let next = 1;
let onLoaded;
let onFailed;
window.ready = new Promise((resolve, reject) => { onLoaded = resolve; onFailed = reject; });
worker.onmessage = ({ data }) => {
  if (data.type === 'loaded') onLoaded(data.ms);
  else if (data.type === 'audio') pending.get(data.id)?.chunks.push(data.samples);
  else if (data.type === 'done') { const job = pending.get(data.id); pending.delete(data.id); job?.resolve(job.chunks); }
  else if (data.type === 'error') {
    const job = data.id ? pending.get(data.id) : null;
    if (job) { pending.delete(data.id); job.reject(new Error(data.message)); } else onFailed(new Error(data.message));
  }
};
worker.onerror = event => onFailed(new Error(event.message || 'the voice worker failed to start'));
// A path, not an http URL: transformers.js looks for local tokenizer files only when the model base isn't http(s)
// (in the extension it is a chrome-extension:// URL); the worker resolves the path against its own origin
worker.postMessage({ type: 'load', engine: 'kokoro', base: '/voice/' });
// One line to speech: the sentences, each as base64 of float32 samples
window.speak = (text, voice, speed) => new Promise((resolve, reject) => {
  const id = next++;
  pending.set(id, { chunks: [], resolve, reject });
  worker.postMessage({ type: 'speak', id, engine: 'kokoro', text, voice, speed });
}).then(chunks => chunks.map(samples => {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}));
// Listening back: the app's own speech recogniser, on a recording decoded and resampled to 16 kHz
let asr = null;
let asrReady = null;
const heard = new Map();
window.listenTo = async (url, model) => {
  if (!asrReady) {
    asr = new Worker(new URL('../../../src/offscreen/stt/asr.worker.ts', import.meta.url), { type: 'module' });
    asrReady = new Promise((resolve, reject) => {
      asr.onmessage = ({ data }) => {
        if (data.type === 'loaded') resolve(data.device);
        else if (data.type === 'text') { heard.get(data.id)?.(data.text); heard.delete(data.id); }
        else if (data.type === 'error' && data.id) { heard.get(data.id)?.('[error] ' + data.message); heard.delete(data.id); }
        else if (data.type === 'error') reject(new Error(data.message));
      };
    });
    asr.postMessage({ type: 'load', model, base: '/voice/', webgpu: false });
  }
  await asrReady;
  const decoded = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(await (await fetch(url)).arrayBuffer());
  const samples = decoded.getChannelData(0).slice();
  const id = next++;
  return new Promise(resolve => {
    heard.set(id, resolve);
    asr.postMessage({ type: 'transcribe', id, audio: samples }, [samples.buffer]);
  });
};
`,
);

console.log('narrate: bundling the app’s voice worker');
const vite = await import(pathToFileURL(vitePath).href);
await vite.build({
  configFile: false,
  root: join(work, 'src'),
  base: '/',
  logLevel: 'warn',
  build: { outDir: join(work, 'dist'), emptyOutDir: true, target: 'esnext', minify: false, assetsInlineLimit: 0 },
  worker: { format: 'es' },
  // As the extension's own build resolves them (wxt.config.ts): the browser builds of transformers.js and
  // kitten-tts-js, never their Node builds
  resolve: { conditions: ['browser', 'module', 'import', 'default'], mainFields: ['browser', 'module', 'main'] },
});

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};
function serveFile(root, pathname, response) {
  const file = join(root, normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    if (process.env.NARRATE_DEBUG) console.log(`narrate: 404 ${pathname}`);
    response.writeHead(404).end();
    return;
  }
  if (process.env.NARRATE_DEBUG) console.log(`narrate: 200 ${pathname}`);
  response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}
const dist = join(work, 'dist');
const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (pathname.startsWith('/voice/')) {
    const rest = pathname.slice('/voice'.length);
    const dir = voiceDirs.find(candidate => existsSync(join(candidate, normalize(decodeURIComponent(rest)))));
    serveFile(dir ?? voiceDir, rest, response);
  } else if (pathname.startsWith('/audio/')) serveFile(audioDir, pathname.slice('/audio'.length), response);
  else serveFile(dist, pathname === '/' ? '/index.html' : pathname, response);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

// ─── Render ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Joins the sentences with a short breath, levels the line and adds a little air before and after. */
function finish(chunks) {
  const gap = Math.round(0.09 * SAMPLE_RATE);
  const lead = Math.round(0.12 * SAMPLE_RATE);
  const tail = Math.round(0.4 * SAMPLE_RATE);
  const length = lead + tail + chunks.reduce((sum, chunk) => sum + chunk.length, 0) + gap * (chunks.length - 1);
  const out = new Float32Array(length);
  let at = lead;
  chunks.forEach((chunk, index) => {
    out.set(chunk, at);
    at += chunk.length + (index < chunks.length - 1 ? gap : 0);
  });
  // Every line at the same loudness (RMS of the voiced part), without clipping
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (const sample of out) {
    const level = Math.abs(sample);
    if (level > peak) peak = level;
    if (level > 0.02) {
      sum += sample * sample;
      count++;
    }
  }
  const rms = count ? Math.sqrt(sum / count) : 0;
  const gain = rms ? Math.min(0.11 / rms, 0.93 / peak) : 1;
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) =>
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), index * 2),
  );
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** How much of the reference was heard: the longest run of its words, in order, found in the transcript. */
function wordMatch(reference, transcript) {
  const words = text =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
  const a = words(reference);
  const b = words(transcript);
  if (!a.length) return 1;
  // Longest common subsequence, one row at a time
  let previous = new Array(b.length + 1).fill(0);
  for (const word of a) {
    const row = [0];
    for (let j = 1; j <= b.length; j++)
      row[j] = word === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], row[j - 1]);
    previous = row;
  }
  return previous[b.length] / a.length;
}

function encode(input, output) {
  const run =
    encoder === 'afconvert'
      ? spawnSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', input, output])
      : spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-c:a', 'aac', '-b:a', '64k', output]);
  if (run.status !== 0) throw new Error(`${encoder} failed: ${String(run.stderr)}`);
}

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
  protocolTimeout: 600_000,
});
mkdirSync(audioDir, { recursive: true });
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error(`narrate: page error: ${error.message}`));
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  const loadMs = await page.evaluate(() => window.ready);
  console.log(`narrate: Kokoro loaded in ${Math.round(loadMs)} ms; voice ${narration.voice}`);
  manifest.voice = narration.voice;
  manifest.engine = 'Kokoro 82M v1.0 (int8), via the app’s local voice worker';
  manifest.lines ??= {};
  for (const line of todo) {
    const started = Date.now();
    const encoded = await page.evaluate(
      (text, voice, speed) => window.speak(text, voice, speed),
      line.say ?? line.text,
      narration.voice,
      narration.speed,
    );
    const chunks = encoded.map(base64 => {
      const bytes = Buffer.from(base64, 'base64');
      return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    });
    const samples = finish(chunks);
    const hash = lineHash(line, narration.voice, narration.speed);
    const name = `${line.id}-${hash}.m4a`;
    const wavPath = join(work, `${line.id}.wav`);
    writeFileSync(wavPath, wav(samples));
    // Older renders of this line go
    for (const old of readdirSync(audioDir))
      if (old.startsWith(`${line.id}-`) && old !== name) rmSync(join(audioDir, old));
    encode(wavPath, join(audioDir, name));
    const seconds = Number((samples.length / SAMPLE_RATE).toFixed(2));
    const bytes = statSync(join(audioDir, name)).size;
    manifest.lines[line.id] = { file: `/audio/${name}`, seconds, bytes, hash };
    console.log(
      `narrate: ${line.id.padEnd(13)} ${seconds.toFixed(1).padStart(5)} s  ${String(Math.round(bytes / 1024)).padStart(4)} KB  (${((Date.now() - started) / 1000).toFixed(1)} s to render)`,
    );
  }
  // Only the lines that exist, in the narration's order
  manifest.lines = Object.fromEntries(
    narration.lines.filter(line => manifest.lines[line.id]).map(line => [line.id, manifest.lines[line.id]]),
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (listen) {
    // Each recording, heard back by the app's own recogniser: the share of the line's words it heard, in order
    console.log(`narrate: listening back with ${recogniser}`);
    for (const line of narration.lines) {
      const entry = manifest.lines[line.id];
      if (!entry) continue;
      const text = await page.evaluate((url, model) => window.listenTo(url, model), entry.file, recogniser);
      const score = wordMatch(line.say ?? line.text, text);
      console.log(`narrate: ${line.id.padEnd(13)} ${String(Math.round(score * 100)).padStart(3)}%  “${text}”`);
      if (score < 0.8) {
        failed = true;
        console.error(`narrate: ${line.id} doesn’t sound like its line; listen to ${entry.file}`);
      }
    }
  }
} catch (error) {
  failed = true;
  console.error(`narrate: ${error.message}`);
} finally {
  await browser.close();
  server.close();
}
if (!failed) rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
