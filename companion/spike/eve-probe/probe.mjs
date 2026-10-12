// Spike only: builds and starts the probe agent with `eve start`, then checks the exit criteria of the
// Avi Brain spike at runtime and prints what it found. Run with `node probe.mjs` after `pnpm install`.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlm } from './mock-llm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const eveBin = path.join(here, 'node_modules', '.bin', 'eve');
const ORIGIN = 'chrome-extension://fckijnclcihjnokahdnbogpbeiimfdio';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function childPids(pid) {
  try {
    const kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    return kids.flatMap(kid => [kid, ...childPids(kid)]);
  } catch {
    return [];
  }
}

// Remote ends of the server's TCP connections that are not this machine
function outboundConnections(pid) {
  const pids = [String(pid), ...childPids(pid)];
  const found = new Set();
  for (const id of pids) {
    let out = '';
    try {
      out = execFileSync('lsof', ['-nP', '-iTCP', '-a', '-p', id], { encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const line of out.split('\n')) {
      const match = /->(\S+)/.exec(line);
      if (match && !/^(127\.0\.0\.1|\[::1\]|localhost)/.test(match[1])) found.add(match[1]);
    }
  }
  return [...found];
}

function listeners(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map(line => line.split(/\s+/)[8]);
  } catch {
    return [];
  }
}

function findKey(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  if (key in value) return value[key];
  for (const inner of Object.values(value)) {
    const found = findKey(inner, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Reads the NDJSON stream from `startIndex` until `until(event)` or the timeout; returns the events. */
async function readStream(base, headers, sessionId, startIndex, until, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(`${base}/eve/v1/session/${sessionId}/stream?startIndex=${startIndex}`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`stream ${response.status}`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        events.push(event);
        if (until(event)) {
          controller.abort();
          return events;
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

async function main() {
  const mock = await startMockLlm();
  const token = crypto.randomBytes(24).toString('base64url');
  const llmKey = `sk-probe-${crypto.randomBytes(12).toString('hex')}`;
  const port = await freePort();
  const env = {
    ...process.env,
    EVE_TELEMETRY_DISABLED: '1',
    PROBE_LLM_URL: mock.baseUrl,
    PROBE_LLM_KEY: llmKey,
    PROBE_TOKEN: token,
  };

  console.log('Building with eve build …');
  execFileSync(eveBin, ['build', '--skip-sandbox-prewarm'], { cwd: here, env, stdio: 'inherit' });

  const server = spawn(eveBin, ['start', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: here,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', data => (serverLog += data));
  server.stderr.on('data', data => (serverLog += data));
  const base = `http://127.0.0.1:${port}`;
  const outbound = new Set();
  const sampler = setInterval(() => outboundConnections(server.pid).forEach(address => outbound.add(address)), 250);

  try {
    let up = false;
    for (let attempt = 0; attempt < 120 && !up; attempt++) {
      up = await fetch(`${base}/eve/v1/health`).then(
        response => response.ok,
        () => false,
      );
      if (!up) await sleep(250);
    }
    if (!up) throw new Error(`eve start did not come up:\n${serverLog.slice(-3000)}`);

    // (f) Binding and route auth
    const bound = listeners(port);
    check(
      'f: listens on 127.0.0.1 only',
      bound.length > 0 && bound.every(addr => addr.startsWith('127.0.0.1:')),
      bound.join(', '),
    );
    const health = await fetch(`${base}/eve/v1/health`);
    check('f: GET /eve/v1/health needs no token (public route)', health.status === 200, `status ${health.status}`);
    const noToken = await fetch(`${base}/eve/v1/session`, { method: 'POST', headers: { Origin: ORIGIN } });
    check('f: create without a token is refused', noToken.status === 401, `status ${noToken.status}`);
    const wrongToken = await fetch(`${base}/eve/v1/session`, {
      method: 'POST',
      headers: { Origin: ORIGIN, Authorization: 'Bearer nope' },
    });
    check('f: create with a wrong token is refused', wrongToken.status === 401, `status ${wrongToken.status}`);
    const wrongOrigin = await fetch(`${base}/eve/v1/session`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', Authorization: `Bearer ${token}` },
    });
    check('f: create from another origin is refused', wrongOrigin.status === 403, `status ${wrongOrigin.status}`);

    const authHeaders = profile => ({
      Origin: ORIGIN,
      Authorization: `Bearer ${token}`,
      'x-avi-profile': profile,
      'content-type': 'application/json',
    });

    async function startSession(profile, message) {
      const response = await fetch(`${base}/eve/v1/session`, {
        method: 'POST',
        headers: authHeaders(profile),
        body: JSON.stringify({ message }),
      });
      const body = await response.json();
      if (response.status !== 202) throw new Error(`create ${response.status} ${JSON.stringify(body)}`);
      return body.sessionId;
    }

    // (a) + (b): the writer profile
    const writer = await startSession('writer', 'hello from writer');
    const writerEvents = await readStream(
      base,
      authHeaders('writer'),
      writer,
      0,
      event => event.type === 'turn.completed',
    );
    const writerCall = mock.calls.find(call => call.model === 'model-writer');
    check(
      'a: the session called the model chosen at runtime (local OpenAI-compatible server)',
      Boolean(writerCall),
      writerCall ? `model ${writerCall.model}` : `calls: ${JSON.stringify(mock.calls.map(c => c.model))}`,
    );
    check(
      'b: writer got its own instructions',
      Boolean(writerCall?.system.includes('PROFILE-WRITER')) && !writerCall?.system.includes('PROFILE-ANALYST'),
    );
    check(
      'b: writer got only its own tools',
      Boolean(writerCall?.tools.includes('shout')) &&
        !writerCall?.tools.includes('add') &&
        !writerCall?.tools.includes('danger'),
      `tools: ${writerCall?.tools.join(', ')}`,
    );
    check(
      'a: the answer came back on the stream',
      writerEvents.some(event => JSON.stringify(event).includes('ECHO model-writer')),
      `event types: ${[...new Set(writerEvents.map(e => e.type))].join(', ')}`,
    );

    // (b) + (e): the analyst profile asks for approval before its side effect
    const callsBefore = mock.calls.length;
    const analyst = await startSession('analyst', 'please use danger');
    const analystEvents = await readStream(
      base,
      authHeaders('analyst'),
      analyst,
      0,
      event => event.type === 'input.requested',
    );
    const analystCall = mock.calls.slice(callsBefore).find(call => call.model === 'model-analyst');
    check(
      'b: analyst got its own instructions and tools',
      Boolean(analystCall?.system.includes('PROFILE-ANALYST')) &&
        Boolean(analystCall?.tools.includes('danger')) &&
        !analystCall?.tools.includes('shout'),
      `tools: ${analystCall?.tools.join(', ')}`,
    );
    const requested = analystEvents.find(event => event.type === 'input.requested');
    const requestId = findKey(requested, 'requestId');
    check(
      'e: a gated tool call waits for a person (input.requested)',
      Boolean(requestId),
      requestId ? `requestId ${requestId}` : `types: ${analystEvents.map(e => e.type).join(', ')}`,
    );
    if (requestId) {
      const answer = await fetch(`${base}/eve/v1/session/${analyst}`, {
        method: 'POST',
        headers: authHeaders('analyst'),
        body: JSON.stringify({ inputResponses: [{ requestId, optionId: 'approve' }] }),
      });
      check('e: inputResponses accepted', answer.status < 300, `status ${answer.status}`);
      const after = await readStream(
        base,
        authHeaders('analyst'),
        analyst,
        analystEvents.length,
        event => event.type === 'turn.completed',
      );
      check(
        'e: the approved call ran and the turn finished',
        after.some(event => JSON.stringify(event).includes('TOOL RESULT')),
        `types: ${[...new Set(after.map(e => e.type))].join(', ')}`,
      );
    }

    // The raw events, for mapping eve's stream onto Avi Brain's protocol
    const fullAnalyst = await readStream(base, authHeaders('analyst'), analyst, 0, () => false, 3000);
    fs.writeFileSync(
      path.join(here, 'events-writer.ndjson'),
      writerEvents.map(event => JSON.stringify(event)).join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(here, 'events-analyst.ndjson'),
      fullAnalyst.map(event => JSON.stringify(event)).join('\n') + '\n',
    );

    // (g) Resume from a cursor: the same events keep their ids
    const replay = await readStream(base, authHeaders('writer'), writer, 0, () => false, 3000);
    const ids = events => events.map(event => event.meta?.id ?? findKey(event, 'id'));
    const firstIds = ids(writerEvents);
    check(
      'g: rewinding to startIndex=0 replays the same event ids',
      firstIds.length > 0 && firstIds.every((id, index) => id === ids(replay)[index]),
      `${firstIds.length} events`,
    );
    const tail = await readStream(base, authHeaders('writer'), writer, writerEvents.length - 1, () => false, 3000);
    check(
      'g: reading from a cursor returns only what follows',
      tail.length >= 1 && ids(tail)[0] === firstIds[firstIds.length - 1],
      `${tail.length} events from ${writerEvents.length - 1}`,
    );

    // (i) What is kept on disk
    const store = path.join(here, '.eve');
    const files = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && fs.statSync(full).size < 20_000_000) files.push(full);
      }
    };
    if (fs.existsSync(store)) walk(store);
    const containing = needle =>
      files.filter(file => fs.readFileSync(file).includes(needle)).map(file => path.relative(here, file));
    const tokenFiles = containing(token);
    const keyFiles = containing(llmKey);
    const messageFiles = containing('please use danger');
    check('i: the route token is not stored on disk', tokenFiles.length === 0, tokenFiles.join(', '));
    check('i: the model key (env only) is not stored on disk', keyFiles.length === 0, keyFiles.join(', '));
    console.log(`info i: messages are kept in plain files: ${messageFiles.slice(0, 3).join(', ') || 'none found'}`);
    const workflowData = path.join(store, '.workflow-data');
    if (fs.existsSync(workflowData)) {
      console.log(`info i: .eve/.workflow-data mode ${(fs.statSync(workflowData).mode & 0o777).toString(8)}`);
    }

    // (h) No connection left this machine while sessions ran
    check('h: no outbound connection off this machine during the run', outbound.size === 0, [...outbound].join(', '));
  } finally {
    clearInterval(sampler);
    server.kill('SIGTERM');
    mock.close();
  }
  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(here, 'probe-results.json'), `${JSON.stringify(results, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
