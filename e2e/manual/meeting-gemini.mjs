/**
 * Manual check of meeting notes with real speech and the real Gemini API. Not part of `pnpm test:e2e`:
 * it needs a Gemini key, macOS `say` for the speech, and a visible window (headless tabs are silent).
 *
 *   GEMINI_API_KEY=... node e2e/manual/meeting-gemini.mjs
 *   node e2e/manual/meeting-gemini.mjs path/to/.env      (reads GEMINI_API_KEY from the file)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launchExtension, pressToolbarButton, sleep } from '../harness.mjs';

const SPEECH =
  'Hi everyone, this is Ada with the weekly sync. First, we agreed that the stage two deadline moves to Friday. ' +
  'Second, Bob will draft the launch post by Thursday. ' +
  'One thing is still open: who books the room for the demo? Let us decide that next week. Thanks, everyone.';

function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const file = process.argv[2];
  const line =
    file &&
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .find(l => l.startsWith('GEMINI_API_KEY='));
  if (!line) throw new Error('Set GEMINI_API_KEY or pass a .env file that has it');
  return line
    .slice('GEMINI_API_KEY='.length)
    .trim()
    .replace(/^["']|["']$/g, '');
}

// Speech as a WAV file, made once with macOS say
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avi-speech-'));
execFileSync('say', ['-o', path.join(dir, 'speech.aiff'), SPEECH]);
execFileSync('afconvert', [
  '-f',
  'WAVE',
  '-d',
  'LEI16@22050',
  path.join(dir, 'speech.aiff'),
  path.join(dir, 'speech.wav'),
]);

const page = `<!doctype html><html><head><title>Weekly sync</title></head><body>
<h1>Weekly sync</h1><audio id="a" src="/speech.wav" autoplay></audio>
<script>document.getElementById('a').addEventListener('ended', () => (window.__ended = true));</script></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/speech.wav') {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    return res.end(fs.readFileSync(path.join(dir, 'speech.wav')));
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(page);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

process.env.E2E_HEADED = '1';
const extension = await launchExtension({ baseUrl: 'http://127.0.0.1:1/v1' });
const key = geminiKey();
await extension.setStorage({
  'llm-api-keys': {
    providers: {
      gemini: {
        name: 'Gemini',
        type: 'gemini',
        apiKey: key,
        modelNames: ['gemini-3.8-flash', 'gemini-3.1-pro-preview'],
        createdAt: Date.now(),
      },
    },
  },
  'agent-models': {
    agents: {
      planner: { provider: 'gemini', modelName: 'gemini-3.1-pro-preview' },
      navigator: { provider: 'gemini', modelName: 'gemini-3.8-flash' },
    },
  },
  'meeting-settings': {
    includeMic: false,
    keepAudio: false,
    consentShown: true,
    chunkSeconds: 15,
    firstChunkSeconds: 6,
    overlapSeconds: 2,
    summaryEverySeconds: 20,
    silenceWarnSeconds: 300,
  },
});

// Background errors, so a failed run says why
const workerTarget = await extension.browser.waitForTarget(
  t => t.type() === 'service_worker' && t.url().startsWith(extension.origin),
);
const worker = await workerTarget.worker();
worker.on('console', message => {
  if (['error', 'warn', 'warning'].includes(message.type())) console.log('[background]', message.text().slice(0, 400));
});

try {
  // Open the page paused, start notes, then play: the whole speech is recorded
  const web = await extension.browser.newPage();
  await web.goto(url);
  await web.evaluate(() => document.getElementById('a').pause());
  const panel = await pressToolbarButton(extension, web);
  await panel.waitForSelector('header');
  const take = await panel.evaluateHandle(() =>
    [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Take meeting notes'),
  );
  await take.asElement().click();
  await panel.waitForFunction(() => document.body.innerText.includes('Recording ·'), { polling: 250, timeout: 15000 });
  await web.evaluate(() => {
    const audio = document.getElementById('a');
    audio.currentTime = 0;
    return audio.play();
  });
  await web.waitForFunction(() => window.__ended === true, { polling: 500, timeout: 90000 });
  await sleep(3000);
  await panel.evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Stop').click());
  await panel
    .waitForFunction(() => /Done ·|Could not write/.test(document.body.innerText), { polling: 500, timeout: 120000 })
    .catch(async () =>
      console.log(
        'Not done in time. Panel:',
        (await panel.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 800),
      ),
    );
  const result = await panel.evaluate(
    () =>
      new Promise(resolve => {
        const open = indexedDB.open('avi-copilot');
        open.onsuccess = () => {
          const all = open.result.transaction('meetings').objectStore('meetings').getAll();
          all.onsuccess = () => resolve(all.result.at(-1));
        };
      }),
  );
  console.log(
    result.status === 'done'
      ? result.markdown
      : `NOT DONE: ${JSON.stringify({ status: result.status, error: result.error, warnings: result.warnings, chunks: `${result.chunksDone}/${result.chunksTotal}` })}`,
  );
} finally {
  await extension.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
