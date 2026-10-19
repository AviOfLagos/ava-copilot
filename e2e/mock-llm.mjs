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

// The system prompt of knowledge base answers, in src/background/kb/answer.ts
const KB_PROMPT = "You answer questions from the user's own knowledge base";
const GRAPH_PROMPT = 'and list what it talks about, for a knowledge graph';
const BRIEF_PROMPT = "From the morning brief's data, pick at most three things";
// A workspace's "where we are", in src/background/history/summary-prompt.ts
const SUMMARY_PROMPT = 'You keep a running "where we are" note';
// The system prompt of teach mode, in src/background/skills/teach.ts
const TEACH_PROMPT = 'You write a skill: a short page of tips';

// Lowercase words hashed into 64 buckets, as a unit vector; the task prefixes are left out
function bagOfWords(text) {
  const vector = new Array(64).fill(0);
  const words =
    text
      .replace(/^(task: search result \| query: |title: .*? \| text: )/, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % 64] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map(value => value / norm);
}

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
  const newRun = name => ({
    name,
    step: 0,
    navigatorCalls: [],
    requests: [],
    images: [],
    // Per navigator call: image parts in the messages before the page state (pictures the user attached)
    attachedImages: [],
    errors: [],
    failures: [],
  });
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

    // A calendar feed, for the reminder tests
    if (req.method === 'GET' && req.url.startsWith('/calendar.ics')) {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      return res.end(calendar.ics);
    }

    const page = req.method === 'GET' && /^\/([\w-]+\.html)/.exec(req.url);
    if (page && fs.existsSync(path.join(here, page[1]))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(here, page[1])));
    }

    // Gemini writing down a dictation: a request with a recording gets the scripted words
    if (req.method === 'POST' && req.url.includes(':generateContent')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parts = (JSON.parse(body).contents ?? []).flatMap(content => content.parts ?? []);
      const audio = parts.find(part => part.inlineData?.mimeType?.startsWith('audio/'));
      if (audio) {
        dictation.recordings.push({ mimeType: audio.inlineData.mimeType, bytes: audio.inlineData.data.length });
        if (dictation.delayMs) await new Promise(resolve => setTimeout(resolve, dictation.delayMs));
        if (dictation.failStatus) {
          res.writeHead(dictation.failStatus, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { code: dictation.failStatus, message: 'Scripted failure' } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: dictation.text }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 6, totalTokenCount: 16 },
          }),
        );
      }
    }

    // Gemini embeddings (the knowledge base): words hashed into buckets, so texts sharing words match
    if (req.method === 'POST' && req.url.includes(':batchEmbedContents')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { requests } = JSON.parse(body);
      kb.embedded.push(...requests.map(entry => entry.content.parts.map(part => part.text).join(' ')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ embeddings: requests.map(entry => ({ values: bagOfWords(entry.content.parts[0].text) })) }),
      );
    }

    // A provider that checks its key, for the first-run setup: /keyed/v1 lists one model for any key but a "bad" one
    // (its chats are answered like every other /chat/completions)
    if (req.method === 'GET' && req.url.startsWith('/keyed/v1/models')) {
      const auth = String(req.headers.authorization ?? '');
      if (!auth || /bad/i.test(auth)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'scripted', object: 'model' }] }));
    }

    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      const system = textOf(request.messages[0] ?? {});

      // Teach mode: the skill drafted from a finished task
      if (system.includes(TEACH_PROMPT)) {
        kb.taught.push(textOf(request.messages[request.messages.length - 1]));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(completion(request, kb.skillDraft)));
      }

      // The morning brief's priorities
      if (system.includes(BRIEF_PROMPT)) {
        kb.briefData.push(textOf(request.messages[request.messages.length - 1]));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(textCompletion(request, kb.briefPriorities)));
      }

      // A workspace summary: written from the titles of the sources it was given, so tests can see its scope
      if (system.includes(SUMMARY_PROMPT)) {
        const prompt = textOf(request.messages[request.messages.length - 1]);
        kb.summaries.push(prompt);
        const titles = [...prompt.matchAll(/^\[(\d+)\] .*?"([^"]+)"/gm)].map(match => [match[1], match[2]]);
        const reply = titles.length
          ? `## Where we are\nWorking on ${titles.map(([n, title]) => `${title} [${n}]`).join(', ')}.\n## Next actions\n${titles
              .map(([n, title]) => `- [ ] Follow up on ${title} (by 2026-10-20) [${n}]`)
              .join('\n')}`
          : '## Where we are\nNothing yet.';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(textCompletion(request, reply)));
      }

      // The knowledge graph's reading of an item
      if (system.includes(GRAPH_PROMPT)) {
        kb.graphReads.push(textOf(request.messages[request.messages.length - 1]));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(completion(request, kb.graphReading)));
      }

      // Knowledge base answers: the scripted answer, with the question and sources kept for checks
      if (system.includes(KB_PROMPT)) {
        kb.questions.push(textOf(request.messages[request.messages.length - 1]));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(textCompletion(request, kb.answer)));
      }

      // Meeting notes: transcription, summaries and the final note answer from their own script
      const meetingKind = MEETING_PROMPTS.find(([, marker]) => system.includes(marker))?.[0];
      if (meetingKind) {
        if (meetingKind === 'transcribe' && meeting.failTranscriptions > 0) {
          meeting.failTranscriptions -= 1;
          res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
          return res.end(JSON.stringify({ error: { message: 'scripted outage' } }));
        }
        // The final note fails outright (a request the model refuses), so the meeting ends up failed
        if (meetingKind === 'note' && meeting.failNotes > 0) {
          meeting.failNotes -= 1;
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'scripted note failure' } }));
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
          run.attachedImages.push(
            request.messages
              .slice(0, -1)
              .flatMap(message => (Array.isArray(message.content) ? message.content : []))
              .filter(part => part.type === 'image_url').length,
          );
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

  // The calendar feed served at /calendar.ics
  const calendar = { ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' };

  // Dictation in the chat box: every recording sent to be written down, and the words that come back
  const dictation = { recordings: [], text: 'remind me to call Ada at five', delayMs: 0, failStatus: 0 };

  // What the knowledge base tests see: every text embedded and every question with its sources
  const kb = {
    embedded: [],
    questions: [],
    answer: 'Stage 2 is due Friday [1].',
    // The knowledge graph: every item read, and what the reading finds
    graphReads: [],
    // The morning brief: the data it was given, and the priorities it answers with
    briefData: [],
    // Workspace summaries: every prompt they were written from
    summaries: [],
    briefPriorities: '- Reply to the waiting post, it blocks the launch\n- Prepare the sponsor sync',
    graphReading: { people: [], organizations: [], projects: [], decisions: [], actions: [] },
    // Teach mode: task logs received, and the draft returned
    taught: [],
    skillDraft: {
      name: 'fixture-quotes',
      description: 'Requesting a quote on the fixture page',
      urls: ['127.0.0.1:*/fixture.html'],
      keywords: ['quote'],
      tips: ['The name field is the first box under "Quote request".'],
    },
  };

  // What the meeting tests see: every audio clip received, and how many lines were handed out
  const meeting = { clips: [], lines: 0, summaries: 0, notes: 0, failTranscriptions: 0, failNotes: 0 };
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
  // A voice session (its setup has tools) hears the scripted request once, calls the tool, answers,
  // and repeats each system notice
  const live = {
    sessions: [],
    lines: 0,
    dropAfter: 0,
    voiceRequest: 'Run the scripted scenario voice-task.',
    notices: [],
    toolResponses: [],
    // Messages typed into the voice conversation's chat: their words and the types of any inline pictures
    typed: [],
    // Screen pictures sent as video frames
    frames: [],
    // Quiet context lines (turnComplete false), e.g. the tab the user switched to
    context: [],
    // Each notice, and whether the user was mid-utterance when it came (audio since the last audioStreamEnd)
    noticeTimings: [],
  };
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
    // A conversation the extension ended, or that dropped
    socket.on('close', () => {
      session.closed = true;
    });
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
        // Whether the user is speaking: audio goes up only while they do, and audioStreamEnd says they stopped
        if (message.realtimeInput?.audio) {
          session.userSpeaking = true;
          session.lastAudioAt = Date.now();
        }
        if (message.realtimeInput?.audioStreamEnd) session.userSpeaking = false;
        if (message.setup) {
          session.setups.push(message.setup);
          session.voice = Boolean(message.setup.tools);
          send({ setupComplete: {} });
          send({ sessionResumptionUpdate: { newHandle: `handle-${live.sessions.length}`, resumable: true } });
        } else if (session.voice && message.toolResponse) {
          live.toolResponses.push(...message.toolResponse.functionResponses);
          const reply = Buffer.alloc(24000).toString('base64');
          send({ serverContent: { outputTranscription: { text: 'Started it.' } } });
          send({
            serverContent: {
              modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: reply } }] },
            },
          });
          send({ serverContent: { turnComplete: true } });
        } else if (session.voice && message.clientContent?.turnComplete === false) {
          // Quiet context (the tab the user switched to): kept, never answered
          live.context.push({
            session: live.sessions.indexOf(session),
            text: message.clientContent.turns[0].parts[0].text,
          });
        } else if (session.voice && message.clientContent) {
          const parts = message.clientContent.turns[0].parts;
          const words = parts.find(part => part.text?.startsWith('The user typed'));
          if (words) {
            live.typed.push({
              session: live.sessions.indexOf(session),
              text: words.text,
              mimeTypes: parts.filter(part => part.inlineData).map(part => part.inlineData.mimeType),
            });
            send({ serverContent: { outputTranscription: { text: 'Got your message.' }, turnComplete: true } });
          } else {
            live.notices.push(parts[0].text);
            live.noticeTimings.push({ text: parts[0].text, userSpeaking: Boolean(session.userSpeaking) });
            send({ serverContent: { outputTranscription: { text: 'Heads up.' }, turnComplete: true } });
          }
        } else if (session.voice && message.realtimeInput?.video) {
          // A picture of the screen (read_screen): its type and size
          live.frames.push({
            session: live.sessions.indexOf(session),
            mimeType: message.realtimeInput.video.mimeType,
            bytes: Buffer.from(message.realtimeInput.video.data, 'base64').length,
          });
        } else if (session.voice && message.realtimeInput?.audio) {
          session.audioBytes += Buffer.from(message.realtimeInput.audio.data, 'base64').length;
          // After a second of microphone audio, the user has asked for something
          if (!session.asked && session.audioBytes >= 32000) {
            session.asked = true;
            send({ serverContent: { inputTranscription: { text: live.voiceRequest } } });
            send({
              toolCall: {
                functionCalls: [
                  {
                    id: 'call-1',
                    ...(live.voiceTool ?? { name: 'run_browser_task', args: { task: live.voiceRequest } }),
                  },
                ],
              },
            });
          }
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
    // The provider that checks its key (see /keyed/v1/models)
    keyedBaseUrl: `http://127.0.0.1:${port}/keyed/v1`,
    fixtureUrl: `http://127.0.0.1:${port}/fixture.html`,
    /** The run of the scenario started last. */
    get run() {
      return runs.get(lastStarted) ?? newRun(null);
    },
    runs,
    meeting,
    live,
    kb,
    calendar,
    dictation,
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

/**
 * A stand-in for Ollama on its own port (11434), for the first-run setup: it lists a chat model and an embedding
 * model, says what each can do, and passes chats on to the mock model. Start it only where nothing else listens.
 */
export async function startMockOllama(
  mock,
  { port = 11434, models: listed = ['qwen3:4b', 'nomic-embed-text'], pullStepMs = 250 } = {},
) {
  // Grows when a model is pulled
  const models = [...listed];
  const pulls = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = value => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url.startsWith('/api/tags')) return json({ models: models.map(name => ({ name, model: name, size: 1 })) });
    if (req.url.startsWith('/api/pull')) {
      // As Ollama answers: a line per step, layers with total/completed, then success; the model is listed after
      const name = String(JSON.parse(body || '{}').model ?? '');
      pulls.push(name);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const send = value => res.write(`${JSON.stringify(value)}\n`);
      send({ status: 'pulling manifest' });
      const total = 4_000_000;
      for (let completed = 0; completed <= total; completed += 1_000_000) {
        await new Promise(resolve => setTimeout(resolve, pullStepMs));
        send({ status: `pulling ${name}`, digest: `sha256:${name}`, total, completed });
      }
      send({ status: 'verifying sha256 digest' });
      if (!models.includes(name)) models.push(name);
      send({ status: 'success' });
      return res.end();
    }
    if (req.url.startsWith('/api/ps')) return json({ models: [] });
    if (req.url.startsWith('/api/show')) {
      const name = String(JSON.parse(body || '{}').model ?? '');
      return json({ capabilities: /embed/.test(name) ? ['embedding'] : ['completion', 'tools'], model_info: {} });
    }
    if (req.url.startsWith('/v1/')) {
      // Chats go to the mock model, which answers by the scenario the task names
      const upstream = await fetch(`http://127.0.0.1:${mock.port}${req.url}`, {
        method: req.method,
        headers: { 'content-type': 'application/json' },
        body: req.method === 'GET' ? undefined : body,
      });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      return res.end(await upstream.text());
    }
    res.writeHead(404).end();
  });
  // Every address, so both localhost (::1) and 127.0.0.1 reach it
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  return {
    models,
    pulls,
    close: () =>
      new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
