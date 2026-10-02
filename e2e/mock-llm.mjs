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
  // The scenario the next task follows, and how far the navigator got in it
  const run = { name: null, step: 0, navigatorCalls: [], images: [], errors: [], failures: [] };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    if (req.method === 'GET' && req.url.startsWith('/fixture.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(here, 'fixture.html')));
    }

    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      // A queued failure answers this call instead of the script, e.g. a 429 to exercise the retry
      const failure = run.failures.shift();
      if (failure) {
        res.writeHead(failure.status, { 'Content-Type': 'application/json', ...failure.headers });
        return res.end(JSON.stringify({ error: { message: `scripted ${failure.status}` } }));
      }
      const system = textOf(request.messages[0] ?? {});
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
            action: step(parseElements(state)),
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

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    fixtureUrl: `http://127.0.0.1:${port}/fixture.html`,
    run,
    start(name) {
      run.name = name;
      run.step = 0;
      run.navigatorCalls = [];
      run.images = [];
      run.errors = [];
      run.failures = [];
    },
    /** Makes the next model call fail with this HTTP status. */
    failNext(status, headers = {}) {
      run.failures.push({ status, headers });
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
