import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, readThreads, sleep } from './harness.mjs';

/**
 * End-to-end test of WS8, the free local voice engines: KittenTTS speaks in the offscreen document (its output
 * measured by an AnalyserNode), Moonshine writes down a recording played as the microphone, and an economy
 * conversation hears a spoken question on the device, answers it with a scripted text model and a voice tool, speaks
 * the answer and ends when told to, with no audio sent to any model, nothing fetched from the internet and no CSP
 * violation. Needs the models: node scripts/voice-models-setup.mjs, then pnpm build.
 */

const root = path.resolve(import.meta.dirname, '..');
const manifest = (dir => {
  const file = path.join(root, dir, 'voice/manifest.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
})('dist');
const hasModels = components => Boolean(components?.kitten && components?.['moonshine-tiny']);
const SKIP = !fs.existsSync(path.join(root, 'public/voice'))
  ? 'the local voice models are missing: run node scripts/voice-models-setup.mjs, then pnpm build'
  : !hasModels(manifest?.components)
    ? 'the build has no voice models: run pnpm build after node scripts/voice-models-setup.mjs'
    : false;
if (SKIP) console.log(`# voice-engines skipped: ${SKIP}`);

process.env.E2E_FAKE_MIC = '1';
// "Hey Ava, what is on my calendar today?" on a loop as the microphone
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');

// Short, so it is heard before the looping recording talks over it again
const ANSWER = 'All clear today.';

/**
 * The economy conversation's text model: an OpenAI-compatible endpoint that calls get_status on the first thing it
 * hears and answers once the tool has answered; after that it says nothing (the recording loops) until the test lets
 * it end the conversation, which it then does on the next thing it hears.
 */
async function startTextModel() {
  const requests = [];
  let userTurns = 0;
  let allowEnd = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'voice-script', object: 'model' }] }));
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) return res.writeHead(404).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const last = request.messages.at(-1);
    let message;
    if (last.role === 'tool') {
      message = { role: 'assistant', content: ANSWER };
    } else {
      userTurns += 1;
      const name = userTurns === 1 ? 'get_status' : allowEnd ? 'end_conversation' : null;
      message = name
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `call_${userTurns}`, type: 'function', function: { name, arguments: '{}' } }],
          }
        : { role: 'assistant', content: '' };
    }
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    // How many times it was asked about something the user said
    get userTurns() {
      return userTurns;
    },
    // From now on, the next thing heard ends the conversation
    allowEnd: () => {
      allowEnd = true;
      return userTurns;
    },
    // Starts the script over: the next thing heard calls get_status, and nothing ends the conversation
    restart: () => {
      userTurns = 0;
      allowEnd = false;
      requests.length = 0;
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

let mock;
let textModel;
let extension;
let session;
// What the offscreen document and its workers report: CSP violations, and any request leaving the computer
const violations = [];
const outside = [];
const watched = new Set();

/** Follows the offscreen document and each of its workers over CDP: Log replays what came before attaching. */
async function watchTargets() {
  for (const target of extension.browser.targets()) {
    const url = target.url();
    if (watched.has(target) || !url.startsWith(extension.origin)) continue;
    if (!url.endsWith('/offscreen.html') && target.type() !== 'other') continue;
    watched.add(target);
    try {
      const cdp = await target.createCDPSession();
      cdp.on('Log.entryAdded', ({ entry }) => {
        if (entry.source === 'security' || /Content Security Policy/i.test(entry.text)) violations.push(entry.text);
      });
      cdp.on('Runtime.consoleAPICalled', event => {
        const text = event.args.map(arg => arg.value ?? arg.description ?? '').join(' ');
        if (/Content Security Policy|Refused to/i.test(text)) violations.push(text);
      });
      cdp.on('Network.requestWillBeSent', ({ request }) => {
        if (!/^(chrome-extension:|data:|blob:|http:\/\/127\.0\.0\.1[:/])/.test(request.url)) outside.push(request.url);
      });
      await cdp.send('Network.enable').catch(() => {});
      await cdp.send('Log.enable');
      await cdp.send('Runtime.enable');
    } catch {
      // A worker that ended before it could be followed
    }
  }
}
let watcher;

/** A panel command with a reply, the way the panel's PanelApi sends one. */
function command(page, message, timeout = 120_000) {
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

const waitFor = async (check, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** The messages of a thread, straight from the extension's IndexedDB. */
function readMessages(page, threadId) {
  return page.evaluate(
    threadId =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('messages').objectStore('messages').index('threadId').getAll(threadId);
          all.onsuccess = () => resolve(all.result.map(({ actor, content }) => ({ actor, content })));
          all.onerror = () => reject(all.error);
        };
      }),
    threadId,
  );
}

before(async () => {
  if (SKIP) return;
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
    // Economy mode asks for the quick model; here it is the scripted one
    'model-settings': { roles: { fast: { providerId: 'voicetext', model: 'voice-script' } } },
    'meeting-settings': { autoNotes: false },
  });
  session = await openSession(extension, mock);
  await session.panel.bringToFront();
});

after(async () => {
  clearInterval(watcher);
  await session?.close().catch(() => {});
  await extension?.close();
  await textModel?.close();
  await mock?.close();
});

// Settings › Voice › Voice engines, on the full-page Settings
let settings;
const clickIn = (page, label) =>
  page.evaluate(label => {
    const button = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === label);
    if (!button) throw new Error(`No button "${label}"`);
    button.click();
  }, label);

test('Settings › Voice engines: KittenTTS says something, and the speech is heard', { skip: SKIP }, async () => {
  const { panel: commands } = session;
  settings = await extension.openSettings('#voice/engines');
  const panel = settings;
  await panel.waitForSelector('#voice-engine-tts', { timeout: 15_000 });
  // The packed models show as packed; the others offer their download (no developer command)
  await panel.waitForFunction(() => /KittenTTS nano\s*Packed with this build/.test(document.body.innerText), {
    polling: 300,
    timeout: 15_000,
  });
  const text = await panel.evaluate(() => document.body.innerText);
  // Section titles are set in capitals by the stylesheet
  assert.match(text, /Voice engines/i);
  assert.match(text, /Moonshine tiny\s*Packed with this build/);
  assert.match(text, /Kokoro[^\n]*\s*Not downloaded · about 97 MB/);
  // Not installed: the choice says it installs first
  assert.match(
    await panel.$eval('#voice-engine-tts option[value="kokoro"]', el => el.textContent),
    /Install \(97 MB\)/,
  );
  assert.doesNotMatch(text, /node scripts\//);

  await panel.select('#voice-engine-tts', 'kitten');
  await waitFor(async () => (await extension.getStorage('tts-settings'))?.engine === 'kitten', 'KittenTTS chosen');
  await panel.bringToFront();
  await clickIn(panel, 'Say something');
  await panel.waitForFunction(
    () => /Spoke in/.test(document.querySelector('[data-testid="voice-engine-result"]')?.textContent ?? ''),
    { polling: 300, timeout: 120_000 },
  );

  const { runtime } = await command(commands, { type: 'voice_engine_status' });
  assert.equal(runtime.tts.engine, 'kitten');
  assert.ok(runtime.tts.loadMs > 0, 'the model was loaded');
  assert.ok(runtime.tts.playedSeconds > 0.5, `speech was made (${runtime.tts.playedSeconds} s)`);
  assert.ok(runtime.tts.peakRms > 0.01, `speech came out of the speakers (peak RMS ${runtime.tts.peakRms})`);
});

test('Moonshine writes down the recording played as the microphone', { skip: SKIP }, async () => {
  const panel = settings;
  await panel.select('#voice-engine-stt', 'moonshine');
  await waitFor(async () => (await extension.getStorage('voice-engine-settings'))?.stt === 'moonshine', 'Moonshine');
  await panel.bringToFront();
  await clickIn(panel, 'Test speech-to-text');
  await panel.waitForFunction(
    () => /Heard “/.test(document.querySelector('[data-testid="voice-engine-result"]')?.textContent ?? ''),
    { polling: 300, timeout: 120_000 },
  );
  const heard = await panel.evaluate(() => document.querySelector('[data-testid="voice-engine-result"]').textContent);
  assert.match(heard, /calendar/i);
});

test(
  'an economy conversation answers a spoken question with a voice tool and speaks it, then ends by voice',
  { skip: SKIP },
  async () => {
    const { panel } = session;
    await settings.select('#voice-engine-mode', 'economy');
    await waitFor(
      async () => (await extension.getStorage('voice-engine-settings'))?.mode === 'economy',
      'economy mode',
    );
    // Settings says which recogniser hears (with its size) and that it only understands English (issue #42)
    await panel.waitForSelector('[data-testid="voice-engine-economy"]');
    const inUse = await panel.evaluate(
      () => document.querySelector('[data-testid="voice-engine-economy"]').textContent,
    );
    assert.match(inUse, /Moonshine tiny|Whisper base/);
    const note = await panel.evaluate(
      () => document.querySelector('[data-testid="voice-engine-languages"]').textContent,
    );
    assert.match(note, /English/);
    // The answer is spoken by KittenTTS (chosen in the first test; set here too so this test stands alone)
    const tts = await extension.getStorage('tts-settings');
    await extension.setStorage({ 'tts-settings': { ...tts, engine: 'kitten' } });
    const spokenBefore = (await command(panel, { type: 'voice_engine_status' })).runtime?.tts.requests ?? 0;

    // The same Talk button as a Live conversation
    await panel.goto(`${extension.origin}/sidepanel.html`);
    await panel.waitForSelector('textarea');
    await panel.bringToFront();
    await session.click('Talk to Ava');

    // The question is written down on the device and goes to the text model as words, with the voice tools
    await waitFor(() => textModel.requests.length >= 2, 'the text model to answer with a tool', 90_000);
    const first = textModel.requests[0];
    const tools = first.tools.map(tool => tool.function.name);
    for (const name of ['get_status', 'run_browser_task', 'end_conversation']) assert.ok(tools.includes(name), name);
    const heard = textModel.requests
      .flatMap(request => request.messages.filter(message => message.role === 'user').map(message => message.content))
      .join(' ');
    assert.match(heard, /calendar|ava/i, 'the recognised words reached the model');
    // get_status ran in the background and its result went back to the model
    const toolReply = textModel.requests[1].messages.find(message => message.role === 'tool');
    assert.match(JSON.stringify(toolReply), /running/i);

    // KittenTTS spoke the answer
    let runtime = null;
    await waitFor(
      async () => {
        ({ runtime } = await command(panel, { type: 'voice_engine_status' }));
        return runtime?.tts.requests > spokenBefore && runtime.tts.peakRms > 0.01;
      },
      'the answer to be spoken',
      60_000,
    ).catch(async error => {
      const voiceThread = (await readThreads(panel)).find(item => item.tags?.includes('voice'));
      const said = voiceThread ? (await readMessages(panel, voiceThread.id)).slice(0, 8) : null;
      throw new Error(
        `${error.message}: ${JSON.stringify({ spokenBefore, runtime, turns: textModel.userTurns, said })}`,
      );
    });

    // The next thing heard ends the conversation through end_conversation
    const turnsSoFar = textModel.allowEnd();
    await waitFor(() => textModel.userTurns > turnsSoFar, 'another spoken turn', 60_000);
    await waitFor(
      async () =>
        !(await panel.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'voice_running' })))
          ?.running,
      'the conversation to end',
      60_000,
    );

    // No audio went to any model: no Live session was ever opened
    assert.equal(mock.live.sessions.length, 0);
    // The exchange is kept in the voice conversation's thread, as with Live
    const thread = (await readThreads(panel)).find(item => item.tags?.includes('voice'));
    assert.ok(thread, 'a voice conversation thread');
    const messages = await readMessages(panel, thread.id);
    assert.ok(messages.some(message => message.actor === 'user' && /calendar|ava/i.test(message.content)));
    assert.ok(messages.some(message => message.actor === 'planner' && message.content === ANSWER));
  },
);

test(
  'with no Gemini key and the voice settings never touched, Talk runs on the device and KittenTTS answers',
  { skip: SKIP },
  async () => {
    const { panel } = session;
    // An install from before "auto": every save wrote the old default Live and Gemini hearing, never picked;
    // the read-aloud voice left at the system default. There is no Gemini key in this profile.
    await extension.setStorage({
      'voice-engine-settings': { mode: 'live', stt: 'gemini', moonshineSize: 'tiny', economyModel: 'fast' },
      'tts-settings': { readAloud: 'voice', engine: 'system', voice: '', rate: 1, lastSpokenMessageId: null },
    });
    const keys = await extension.getStorage('llm-api-keys');
    assert.ok(!Object.values(keys.providers).some(provider => provider.type === 'gemini'), 'no Gemini key');
    textModel.restart();
    const spokenBefore = (await command(panel, { type: 'voice_engine_status' })).runtime?.tts.requests ?? 0;
    const sessionsBefore = mock.live.sessions.length;

    await panel.goto(`${extension.origin}/sidepanel.html`);
    await panel.waitForSelector('textarea');
    await panel.bringToFront();
    await session.click('Talk to Ava');

    // Heard on the device (Moonshine), answered by the text model with a tool, then spoken by KittenTTS
    await waitFor(() => textModel.requests.length >= 2, 'the text model to answer', 90_000);
    const heard = textModel.requests
      .flatMap(request => request.messages.filter(message => message.role === 'user').map(message => message.content))
      .join(' ');
    assert.match(heard, /calendar|ava/i, 'the recognised words reached the model');
    let runtime = null;
    await waitFor(
      async () => {
        ({ runtime } = await command(panel, { type: 'voice_engine_status' }));
        return runtime?.tts.requests > spokenBefore && runtime.tts.peakRms > 0.01;
      },
      'the answer to be spoken',
      60_000,
    );
    assert.equal(runtime.tts.engine, 'kitten', 'a conversation speaks with KittenTTS when the voice was never picked');
    assert.equal(mock.live.sessions.length, sessionsBefore, 'no Live session: nothing needed a key');
    // The old stored "live" was never picked: it reads as auto now
    const settings = await panel.evaluate(() =>
      chrome.storage.local.get('voice-engine-settings').then(items => items['voice-engine-settings']),
    );
    assert.notEqual(settings?.modeChosen, true);

    textModel.allowEnd();
    await waitFor(
      async () =>
        !(await panel.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'voice_running' })))
          ?.running,
      'the conversation to end',
      60_000,
    );
  },
);

test(
  'dictation in the chat box is written down on the device when there is no Gemini key',
  { skip: SKIP },
  async () => {
    const { panel } = session;
    const wav = fs.readFileSync(path.resolve(import.meta.dirname, 'hey-ava.wav')).toString('base64');
    const reply = await panel.evaluate(
      audio =>
        new Promise((resolve, reject) => {
          const port = chrome.runtime.connect({ name: 'side-panel-connection' });
          const timer = setTimeout(() => reject(new Error('speech_to_text timed out')), 120_000);
          port.onMessage.addListener(message => {
            if (message.type !== 'speech_to_text_result' && message.type !== 'speech_to_text_error') return;
            clearTimeout(timer);
            port.disconnect();
            resolve(message);
          });
          port.postMessage({ type: 'speech_to_text', audio: `data:audio/wav;base64,${audio}` });
        }),
      wav,
    );
    assert.equal(reply.type, 'speech_to_text_result', JSON.stringify(reply));
    assert.match(reply.text, /calendar/i);
  },
);

test(
  'no CSP violation, and nothing fetched from the internet, in the offscreen document or its workers',
  { skip: SKIP },
  async () => {
    await watchTargets();
    await sleep(500);
    assert.ok(watched.size >= 2, 'the offscreen document and its workers were followed');
    assert.deepEqual(violations, []);
    assert.deepEqual(outside, []);
  },
);
