import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A stand-in for the model: an OpenAI-compatible endpoint that answers from a script.
 * The tests point the extension at it, so the agent takes exactly the actions under test
 * and the run costs nothing and never varies. It also serves the fixture page.
 */

// Reads the interactive elements the navigator was shown: lines like `[12]<button type=submit>Send</button>`
export function parseElements(stateText) {
  const elements = [];
  const pattern = /^\s*\*?\[(\d+)\]<(\w+)([^>]*)>(.*)$/gm;
  for (const match of stateText.matchAll(pattern)) {
    elements.push({ index: Number(match[1]), tag: match[2], attributes: match[3], text: match[4] });
  }
  return {
    elements,
    // The index of the first element with this tag whose attributes or text contain `needle`
    find(tag, needle) {
      const found = elements.find(
        el => el.tag === tag && `${el.attributes} ${el.text}`.toLowerCase().includes(needle.toLowerCase()),
      );
      if (!found) {
        throw new Error(`No <${tag}> containing "${needle}" among ${elements.length} elements`);
      }
      return found.index;
    },
  };
}

function textOf(message) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.map(part => part.text ?? '').join('\n');
  return '';
}

// The system prompts of the meeting calls, in src/background/meetings/notes.ts
const MEETING_PROMPTS = [
  ['qa', 'You answer questions about a meeting'],
  ['transcribe', 'You transcribe a clip of a meeting recording'],
  ['rolling', 'You keep a running summary of a live meeting'],
  ['block', 'Summarize this part of a meeting transcript'],
  ['note', 'You write the notes of a meeting'],
];

function textCompletion(request, text) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function completion(request, payload) {
  const json = JSON.stringify(payload);
  const tool = request.tools?.[0]?.function?.name;
  const message = tool
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: tool, arguments: json } }],
      }
    : { role: 'assistant', content: json };
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/**
 * @param scenarios - name → list of steps; each step maps the page elements to the navigator's actions
 */
export async function startMockLlm(scenarios) {
  // Each scenario keeps its own progress, so several threads can follow different scripts at once.
  // A call belongs to the scenario its task names: "Run the scripted scenario <name>".
  const runs = new Map();
  const newRun = name => ({ name, step: 0, navigatorCalls: [], requests: [], images: [], errors: [], failures: [] });
  let lastStarted = null;
  const runFor = request => {
    const text = request.messages.map(textOf).join('\n');
    const named = [...text.matchAll(/scripted scenario ([\w-]+)/g)].map(match => match[1]).pop();
    return runs.get(named) ?? runs.get(lastStarted) ?? newRun(null);
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    const page = req.method === 'GET' && /^\/([\w-]+\.html)/.exec(req.url);
    if (page && fs.existsSync(path.join(here, page[1]))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(here, page[1])));
    }

    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      const system = textOf(request.messages[0] ?? {});

      // Meeting notes: transcription, summaries and the final note answer from their own script
      const meetingKind = MEETING_PROMPTS.find(([, marker]) => system.includes(marker))?.[0];
      if (meetingKind) {
        if (meetingKind === 'transcribe' && meeting.failTranscriptions > 0) {
          meeting.failTranscriptions -= 1;
          res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
          return res.end(JSON.stringify({ error: { message: 'scripted outage' } }));
        }
        const reply = meetingReply(meetingKind, request);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify(typeof reply === 'string' ? textCompletion(request, reply) : completion(request, reply)),
        );
      }

      const run = runFor(request);
      run.requests.push(request.messages.map(textOf).join('\n'));
      // A queued failure answers this call instead of the script, e.g. a 429 to exercise the retry
      const failure = run.failures.shift();
      if (failure) {
        res.writeHead(failure.status, { 'Content-Type': 'application/json', ...failure.headers });
        return res.end(JSON.stringify({ error: { message: `scripted ${failure.status}` } }));
      }
      const isNavigator = system.includes('<system_instructions>');
      let payload;
      try {
        const steps = scenarios[run.name];
        if (!steps) throw new Error(`No scenario set for this task (got "${run.name}")`);
        if (isNavigator) {
          const last = request.messages[request.messages.length - 1];
          const state = textOf(last);
          run.navigatorCalls.push(state);
          run.images.push(Array.isArray(last.content) && last.content.some(part => part.type === 'image_url'));
          const step = steps[Math.min(run.step, steps.length - 1)];
          run.step += 1;
          payload = {
            current_state: {
              evaluation_previous_goal: 'Unknown',
              memory: `step ${run.step}`,
              next_goal: 'next scripted step',
            },
            action: await step(parseElements(state)),
          };
        } else {
          const done = run.step >= steps.length;
          payload = {
            observation: 'scripted',
            challenges: '',
            done,
            next_steps: done ? '' : 'Follow the scripted steps.',
            final_answer: done ? 'E2E scenario finished.' : '',
            reasoning: 'scripted',
            web_task: true,
          };
        }
      } catch (error) {
        run.errors.push(String(error.message ?? error));
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: String(error.message ?? error) } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(completion(request, payload)));
    }

    res.writeHead(404).end();
  });

  // What the meeting tests see: every audio clip received, and how many lines were handed out
  const meeting = { clips: [], lines: 0, summaries: 0, notes: 0, failTranscriptions: 0 };
  const meetingReply = (kind, request) => {
    if (kind === 'transcribe') {
      const audio = request.messages
        .flatMap(m => (Array.isArray(m.content) ? m.content : []))
        .find(part => part.type === 'input_audio');
      meeting.clips.push(audio?.input_audio ?? null);
      meeting.lines += 1;
      return { segments: [{ start: 0.6, end: 1.4, speaker: 'Ada', text: `Line ${meeting.lines}` }] };
    }
    if (kind === 'rolling') {
      meeting.summaries += 1;
      return `Summary: ${meeting.lines} lines so far.`;
    }
    if (kind === 'block') {
      return 'Block summary.';
    }
    if (kind === 'qa') {
      const asked = textOf(request.messages[request.messages.length - 1]);
      const lines = (asked.match(/\] Ada: Line \d+/g) ?? []).length;
      const captions = (asked.match(/Live words \d+/g) ?? []).length;
      return `Answer from ${lines} transcript lines and ${captions} live captions.`;
    }
    meeting.notes += 1;
    return {
      title: 'Weekly sync notes',
      tldr: ['Stage 2 moves to Friday', 'Ada drafts the launch post', 'Budget unchanged'],
      decisions: ['Stage 2 deadline is Friday'],
      actionItems: [{ owner: 'Ada', task: 'Draft the launch post', due: 'Thursday' }],
      openQuestions: ['Who books the room?'],
      participants: ['Ada'],
    };
  };

  // The Gemini Live API over a WebSocket: a caption for every two seconds of audio received
  const live = { sessions: [], lines: 0, dropAfter: 0 };
  server.on('upgrade', (req, socket) => {
    if (!req.url.includes('BidiGenerateContent')) return socket.destroy();
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const session = {
      key: new URL(req.url, 'http://mock').searchParams.get('key'),
      setups: [],
      mimeTypes: new Set(),
      audioBytes: 0,
      captions: 0,
    };
    live.sessions.push(session);
    const send = message => {
      const data = Buffer.from(JSON.stringify(message));
      const header =
        data.length < 126
          ? Buffer.from([0x81, data.length])
          : Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
      socket.write(Buffer.concat([header, data]));
    };
    let pending = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 0x0f;
        const masked = (pending[1] & 0x80) !== 0;
        let length = pending[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          length = Number(pending.readBigUInt64BE(2));
          offset = 10;
        }
        const total = offset + (masked ? 4 : 0) + length;
        if (pending.length < total) return;
        const payload = Buffer.from(pending.subarray(total - length, total));
        if (masked) {
          const mask = pending.subarray(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        pending = pending.subarray(total);
        if (opcode === 0x8) return socket.end();
        if (opcode !== 0x1) continue;
        const message = JSON.parse(payload.toString());
        if (message.setup) {
          session.setups.push(message.setup);
          send({ setupComplete: {} });
          send({ sessionResumptionUpdate: { newHandle: `handle-${live.sessions.length}`, resumable: true } });
        } else if (message.realtimeInput?.audio) {
          session.mimeTypes.add(message.realtimeInput.audio.mimeType);
          session.audioBytes += Buffer.from(message.realtimeInput.audio.data, 'base64').length;
          // Two seconds of 16 kHz 16-bit audio is 64000 bytes
          while (session.audioBytes >= (session.captions + 1) * 64000) {
            session.captions += 1;
            live.lines += 1;
            send({ serverContent: { inputTranscription: { text: `Live words ${live.lines}` } } });
            if (live.dropAfter && live.lines === live.dropAfter) {
              live.dropAfter = 0;
              // A dropped connection, as on a flaky network
              return socket.destroy();
            }
          }
        }
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    fixtureUrl: `http://127.0.0.1:${port}/fixture.html`,
    /** The run of the scenario started last. */
    get run() {
      return runs.get(lastStarted) ?? newRun(null);
    },
    runs,
    meeting,
    live,
    start(name) {
      runs.set(name, newRun(name));
      lastStarted = name;
    },
    /** Makes the next model call fail with this HTTP status. */
    failNext(status, headers = {}) {
      this.run.failures.push({ status, headers });
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
