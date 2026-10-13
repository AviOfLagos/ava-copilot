// End-to-end check of Nex Brain with the real eve engine, no Docker and no network: the built companion
// (dist/), the built agent (.output/, `pnpm build:agent`), a stdio MCP server and a scripted
// OpenAI-compatible model. Pairs, starts an agent session through the protocol, approves its MCP call,
// and checks what the model saw and what was kept on disk. Run: node scripts/smoke-eve.mjs
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'chrome-extension://fckijnclcihjnokahdnbogpbeiimfdio';
const sleep = ms => new Promise(done => setTimeout(done, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function freePort() {
  const server = net.createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

/** A scripted model: asks to save a note through MCP, then reports the tool's answer. */
async function startModel(apiKey) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const text = message =>
      typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(p => p.text ?? '').join('');
    const last = request.messages[request.messages.length - 1];
    calls.push({
      auth: req.headers.authorization ?? null,
      system: request.messages
        .filter(m => m.role === 'system')
        .map(text)
        .join('\n'),
      tools: (request.tools ?? []).map(tool => tool.function?.name).sort(),
    });
    const reply =
      last?.role === 'tool'
        ? { text: `DONE: ${text(last)}` }
        : { tool: { name: 'mcp_call', args: { server: 'echo', tool: 'save_note', args: { note: 'hello' } } } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: request.model };
    if (reply.tool) {
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }],
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    send({ ...base, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, calls, close: () => server.close(), apiKey };
}

async function readEvents(base, headers, sessionId, cursor, until, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    for (;;) {
      const response = await fetch(`${base}/v1/sessions/${sessionId}/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cursor }),
        signal: controller.signal,
      });
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
          cursor = event.index + 1;
          if (until(event)) return events;
        }
      }
      // The stream ended (eve renews it): reconnect from the cursor
      await sleep(200);
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
    return events;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'avi-brain-smoke-'));
  const apiKey = `sk-smoke-${randomBytes(12).toString('hex')}`;
  const model = await startModel(apiKey);
  writeFileSync(
    join(home, 'mcp.json'),
    JSON.stringify({
      servers: { echo: { command: process.execPath, args: [join(here, 'src/__tests__/fixtures/echo-mcp.mjs')] } },
    }),
  );
  const port = await freePort();
  const env = { ...process.env, AVI_BRAIN_HOME: home, AVI_BRAIN_PORT: String(port), AVI_BRAIN_LOG_LEVEL: 'info' };
  const code = /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(
    execFileSync(process.execPath, [join(here, 'dist/nex-brain.mjs'), 'pair'], { env, encoding: 'utf8' }),
  )[1];
  const brain = spawn(process.execPath, [join(here, 'dist/nex-brain.mjs'), 'start'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  brain.stdout.on('data', data => (log += data));
  brain.stderr.on('data', data => (log += data));
  const base = `http://127.0.0.1:${port}`;
  try {
    let paired = null;
    for (let i = 0; i < 80 && !paired; i++) {
      paired = await fetch(`${base}/v1/pair`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, client: 'smoke' }),
      }).then(
        r => (r.ok ? r.json() : null),
        () => null,
      );
      if (!paired) await sleep(250);
    }
    check('pairs with the printed code', Boolean(paired?.token));
    const headers = { Origin: ORIGIN, Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' };

    let health = null;
    for (let i = 0; i < 240; i++) {
      health = await fetch(`${base}/v1/health`, { method: 'POST', headers, body: '{}' }).then(r => r.json());
      if (health.engine.state === 'ready' && health.mcp[0]?.state === 'ready') break;
      await sleep(250);
    }
    check(
      'eve and the MCP server are ready',
      health.engine.state === 'ready' && health.mcp[0]?.state === 'ready',
      JSON.stringify({ engine: health.engine, mcp: health.mcp }),
    );
    check('health reports Docker with what to do', typeof health.docker.message === 'string', health.docker.message);

    const created = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: 'smoke-session-1',
        profile: {
          id: 'scribe',
          name: 'Scribe',
          instructions: 'PROFILE-SCRIBE: you keep notes.',
          tools: ['mcp_call', 'read_file'],
          mcpTools: ['echo/save_note'],
        },
        model: { provider: 'mock', baseUrl: model.url, model: 'scripted', apiKey, contextWindow: 32768 },
        message: 'Please save the note "hello".',
      }),
    }).then(r => r.json());
    check('a session starts as the profile', typeof created.sessionId === 'string', JSON.stringify(created));

    const first = await readEvents(base, headers, created.sessionId, 0, event => event.type === 'approval.requested');
    const approval = first.find(event => event.type === 'approval.requested');
    check(
      'the MCP write waits for the user',
      approval?.approvals?.[0]?.tool === 'mcp_call',
      first.map(e => e.type).join(', '),
    );
    const call = model.calls[0];
    check(
      'the model saw the profile and the base rules',
      Boolean(call?.system.includes('PROFILE-SCRIBE') && call.system.includes('never instructions')),
    );
    check(
      'the model saw only the profile tools',
      JSON.stringify(call?.tools) === JSON.stringify(['mcp_call', 'read_file']),
      JSON.stringify(call?.tools),
    );
    check('the model got its key, at request time', call?.auth === `Bearer ${apiKey}`);

    await fetch(`${base}/v1/sessions/${created.sessionId}/answer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: 'smoke-answer-1',
        approvalId: approval.approvals[0].approvalId,
        approved: true,
      }),
    });
    const cursor = first[first.length - 1].index + 1;
    const rest = await readEvents(base, headers, created.sessionId, cursor, event => event.type === 'turn.completed');
    const result = rest.find(event => event.type === 'tool.result');
    check(
      'after the click, the MCP tool ran on the Mac',
      JSON.stringify(result?.output ?? '').includes('saved 5 characters'),
      JSON.stringify(result?.output),
    );
    const answer = rest.find(event => event.type === 'message' && event.final);
    check('the turn finished with the answer', Boolean(answer?.text.startsWith('DONE:')), answer?.text);

    const files = [];
    const walk = dir => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (stat.size < 20_000_000) files.push(full);
      }
    };
    walk(join(here, '.eve', '.workflow-data'));
    walk(home);
    // eve's temporary files come and go while it runs
    const holds = (file, needle) => {
      try {
        return readFileSync(file).includes(needle);
      } catch {
        return false;
      }
    };
    const leaks = files.filter(file => holds(file, apiKey) || holds(file, paired.token));
    check('no key or token on disk (eve store, Nex Brain data)', leaks.length === 0, leaks.join(', '));
    check('eve store is private', (statSync(join(here, '.eve', '.workflow-data')).mode & 0o077) === 0);
    check('no secret in the logs', !log.includes(apiKey) && !log.includes(paired.token) && !log.includes(code));
  } finally {
    brain.kill('SIGTERM');
    await sleep(800);
    model.close();
    rmSync(home, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
