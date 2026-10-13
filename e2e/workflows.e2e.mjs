import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end test of workflows: the user asks in chat for a morning routine, the agent drafts it, the panel
 * shows the diagram with every node new, Create turns it on, feedback in chat ("also add GitHub trending")
 * drafts a change that Apply takes in, Run now lights the nodes up to succeeded, and the morning brief gets
 * the section: added to a brief made before the run, and inside a brief made after it.
 *
 * A small proxy sits in front of the scripted model: it answers the routine-writing call and the summary
 * step itself (recognised by their instructions), serves made-up Hacker News, Hugging Face and GitHub pages,
 * and passes everything else to mock-llm.mjs. A test-only setting points the routine's real addresses at it.
 */

const AUTHORING_MARKER = 'You design routines (workflows) for Nex Copilot';
const SUMMARY_MARKER = "You are one step of the user's routine";
const REQUEST =
  'Every morning at 7:30 check Hacker News and Hugging Face for the latest and put the best in my morning brief';
const SUMMARY =
  '- **[Fake story one](https://example.com/one)** is the scripted pick\n- **[Fake paper](https://huggingface.co/papers/2610.00001)** is another';

const HN = {
  hits: [
    { title: 'Fake story one', url: 'https://example.com/one', points: 321, objectID: '1', _highlightResult: { x: 1 } },
    { title: 'Fake story two', url: 'https://example.com/two', points: 99, objectID: '2' },
  ],
};
const HF = [{ paper: { id: '2610.00001', title: 'Fake paper', summary: 'A scripted abstract.', upvotes: 42 } }];
const GH =
  '<html><body><h1>Trending</h1><article><h2>fake/repo</h2><p>A scripted repository</p></article></body></html>';

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const scenarios = {
  'flow-create': [() => [{ create_workflow: { intent: 'Draft the routine', request: REQUEST } }], done],
  'flow-update': [
    () => [
      {
        update_workflow: { intent: 'Change the routine', id: 'Morning tech news', change: 'also add GitHub trending' },
      },
    ],
    done,
  ],
};

// The routine as the scripted model writes it, in the flat shape the structured call asks for
function authored(withGitHub) {
  const node = (id, type, label, params) => ({
    id,
    type,
    label,
    params: Object.entries(params).map(([key, value]) => ({ key, value: String(value) })),
  });
  const input = `Hacker News:\n{{steps.hn.output}}\n\nHugging Face:\n{{steps.hf.output}}${withGitHub ? '\n\nGitHub trending:\n{{steps.gh.output}}' : ''}`;
  return {
    name: 'Morning tech news',
    description: 'Every morning at 07:30, the best of Hacker News and Hugging Face in the brief.',
    nodes: [
      node('morning', 'trigger.schedule', 'Every morning', { cron: '30 7 * * *', timezone: '' }),
      node('hn', 'step.http_get', 'Hacker News front page', {
        url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30',
        format: 'json',
      }),
      node('hf', 'step.http_get', 'Hugging Face daily papers', {
        url: 'https://huggingface.co/api/daily_papers',
        format: 'json',
      }),
      ...(withGitHub
        ? [node('gh', 'step.http_get', 'GitHub trending', { url: 'https://github.com/trending', format: 'text' })]
        : []),
      node('pick', 'step.llm', 'Pick and summarise the best', {
        instructions: 'Pick the five most interesting items.',
        input,
      }),
      node('brief', 'out.brief_section', 'Add to the morning brief', {
        title: 'Tech news',
        content: '{{steps.pick.output}}',
      }),
    ],
    edges: [
      ['morning', 'hn'],
      ['morning', 'hf'],
      ...(withGitHub
        ? [
            ['morning', 'gh'],
            ['gh', 'pick'],
          ]
        : []),
      ['hn', 'pick'],
      ['hf', 'pick'],
      ['pick', 'brief'],
    ].map(([from, to]) => ({ from, to, when: 'always' })),
    allowHosts: ['hn.algolia.com', 'huggingface.co', ...(withGitHub ? ['github.com'] : [])],
  };
}

const textOf = message =>
  typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map(part => part.text ?? '').join('\n')
      : '';

function reply(res, request, content, asJson) {
  const payload = asJson ? JSON.stringify(content) : content;
  const tool = asJson && request.tools?.[0]?.function?.name;
  const message = tool
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: tool, arguments: payload } }],
      }
    : { role: 'assistant', content: payload };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'chatcmpl-flow',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    }),
  );
}

async function startProxy(mock) {
  const seen = { authoring: [], summaries: [], fetched: [] };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const source = req.method === 'GET' && /^\/(hn|hf|gh)\//.exec(req.url)?.[1];
    if (source) {
      seen.fetched.push(source);
      if (source === 'gh') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(GH);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(source === 'hn' ? HN : HF));
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      const request = JSON.parse(body);
      const instructions = request.messages
        .filter(message => message.role === 'system' || message.role === 'developer')
        .map(textOf)
        .join('\n');
      const said = request.messages
        .filter(message => message.role === 'user')
        .map(textOf)
        .join('\n');
      if (instructions.includes(AUTHORING_MARKER)) {
        seen.authoring.push(said);
        return reply(res, request, authored(said.includes('GitHub')), true);
      }
      if (instructions.includes(SUMMARY_MARKER)) {
        seen.summaries.push(said);
        return reply(res, request, SUMMARY, false);
      }
    }
    // Everything else is the scripted chat, the brief and the fixture page
    const upstream = await fetch(`http://127.0.0.1:${mock.port}${req.url}`, {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] ?? 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function readStore(page, store) {
  return page.evaluate(
    store =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction(store).objectStore(store).getAll();
          all.onsuccess = () => {
            resolve(all.result);
            open.result.close();
          };
          all.onerror = () => reject(all.error);
        };
      }),
    store,
  );
}

async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`${message} (timed out)`);
}

let mock;
let proxy;
let extension;

before(async () => {
  mock = await startMockLlm(scenarios);
  proxy = await startProxy(mock);
  extension = await launchExtension({ ...mock, baseUrl: proxy.baseUrl });
  // Test only: the routine's real sources are fetched from the proxy instead
  await extension.setStorage({
    'workflow-settings': {
      urlOverrides: {
        'https://hn.algolia.com/': `${proxy.origin}/hn/`,
        'https://huggingface.co/': `${proxy.origin}/hf/`,
        'https://github.com/': `${proxy.origin}/gh/`,
      },
    },
  });
});

after(async () => {
  await extension?.close();
  await proxy?.close();
  await mock?.close();
});

async function openWorkflows(session) {
  await session.panel.bringToFront();
  await session.click('Menu');
  await session.click('Workflows');
  await session.panel
    .waitForFunction(() => document.querySelector('#flow-templates') !== null, { polling: 300, timeout: 10000 })
    .catch(async error => {
      // Say what the panel showed instead, so a failure explains itself
      throw new Error(
        `${error.message}. Panel shows: ${(await session.panelText()).slice(0, 800)}; errors: ${session.panelErrors.join(' | ')}`,
      );
    });
}

async function openWorkflow(session, name) {
  await session.panel.waitForSelector(`[data-workflow="${name}"]`, { timeout: 10000 });
  await session.panel.evaluate(name => document.querySelector(`[data-workflow="${name}"]`).click(), name);
  await session.panel.waitForSelector('[data-flow-node]', { timeout: 10000 });
}

const diagram = session =>
  session.panel.evaluate(() =>
    [...document.querySelectorAll('[data-flow-node]')].map(node => ({
      id: node.dataset.flowNode,
      status: node.dataset.status,
      change: node.dataset.change,
    })),
  );

async function makeBrief(page) {
  const reply = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'brief_make' }));
  assert.ok(reply?.threadId, `the brief was made: ${JSON.stringify(reply)}`);
  return reply.threadId;
}

const messagesOf = async (page, threadId) =>
  (await readStore(page, 'messages')).filter(message => message.threadId === threadId).sort((a, b) => a.seq - b.seq);

test('a routine asked for in chat: draft diagram, create, feedback, run now, and the morning brief', async () => {
  const session = await openSession(extension, mock);

  // 1. Asked for in chat: the agent drafts it with a separate structured call; nothing runs yet
  mock.start('flow-create');
  await session.send(`Run the scripted scenario flow-create. ${REQUEST}`);
  await session.waitForEnd(90000);
  assert.equal(proxy.seen.authoring.length, 1, 'one routine-writing call');
  assert.ok(proxy.seen.authoring[0].includes(REQUEST), 'the user words reached the routine writer');
  const [draft] = await until(async () => {
    const workflows = await readStore(session.panel, 'workflows');
    return workflows.length ? workflows : null;
  }, 'the draft was saved');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.spec, null);
  assert.equal(draft.draft.spec.nodes.length, 5);
  assert.deepEqual(await readStore(session.panel, 'runs'), [], 'a draft never runs');

  // 2. The panel shows it as a diagram, every node new, with Create
  await openWorkflows(session);
  await openWorkflow(session, 'Morning tech news');
  let nodes = await diagram(session);
  assert.deepEqual(nodes.map(node => node.id).sort(), ['brief', 'hf', 'hn', 'morning', 'pick']);
  assert.ok(
    nodes.every(node => node.change === 'added'),
    `all new: ${JSON.stringify(nodes)}`,
  );
  assert.match(await session.panelText(), /\+5 new/);
  assert.match(await session.panelText(), /Reaches: hn\.algolia\.com, huggingface\.co/);
  await session.click('Create');
  const created = await until(async () => {
    const [workflow] = await readStore(session.panel, 'workflows');
    return workflow.status === 'active' ? workflow : null;
  }, 'Create turned it on');
  assert.equal(created.version, 1);
  const [job] = (await readStore(session.panel, 'jobs')).filter(item => item.key === `workflow:${created.id}`);
  assert.equal(job.cron, '30 7 * * *');
  assert.equal(new Date(job.runAt).getHours(), 7);
  assert.equal(new Date(job.runAt).getMinutes(), 30);

  // 3. Feedback in chat drafts a change; the diagram marks what it adds, and Apply takes it in
  await session.click('Menu');
  await session.click('Home');
  await session.panel.waitForSelector('textarea', { timeout: 10000 });
  mock.start('flow-update');
  await session.send('Run the scripted scenario flow-update. Also add GitHub trending.');
  await session.waitForEnd(90000);
  assert.equal(proxy.seen.authoring.length, 2);
  assert.ok(proxy.seen.authoring[1].includes('"id":"hn"'), 'the change was written from the routine as it is');
  const pending = await until(async () => {
    const [workflow] = await readStore(session.panel, 'workflows');
    return workflow.draft ? workflow : null;
  }, 'the change waits as a draft');
  assert.equal(pending.status, 'active');
  assert.equal(pending.version, 1);
  await openWorkflows(session);
  await openWorkflow(session, 'Morning tech news');
  nodes = await diagram(session);
  assert.equal(nodes.find(node => node.id === 'gh')?.change, 'added');
  assert.equal(nodes.find(node => node.id === 'pick')?.change, 'changed');
  assert.equal(nodes.find(node => node.id === 'hn')?.change, 'none');
  await session.click('Apply');
  await until(async () => {
    const [workflow] = await readStore(session.panel, 'workflows');
    return workflow.version === 2 && !workflow.draft;
  }, 'Apply took the change in');

  // 4. Today's brief is made before the run
  const earlyBrief = await makeBrief(session.panel);
  assert.ok(!(await messagesOf(session.panel, earlyBrief)).some(message => message.content.includes('Tech news')));

  // 5. Run now: the nodes light up to succeeded
  await session.panel.bringToFront();
  await session.click('Run now');
  await session.panel.waitForFunction(
    () => {
      const nodes = [...document.querySelectorAll('[data-flow-node]')];
      return nodes.length === 6 && nodes.every(node => node.dataset.status === 'succeeded');
    },
    { polling: 300, timeout: 60000 },
  );
  const [run] = await readStore(session.panel, 'runs');
  assert.equal(run.status, 'succeeded');
  assert.equal(run.tainted, true, 'a run that fetched pages is tainted');
  assert.deepEqual([...proxy.seen.fetched].sort(), ['gh', 'hf', 'hn']);
  const summaryInput = proxy.seen.summaries.at(-1);
  assert.match(summaryInput, /nano_untrusted_content/, 'fetched content reaches the model marked as data');
  assert.match(summaryInput, /Fake story one/);
  assert.match(summaryInput, /Fake paper/);
  assert.match(summaryInput, /fake\/repo/);
  assert.doesNotMatch(summaryInput, /_highlightResult/, 'internal fields are dropped');

  // 6. The brief made before the run gets the section added; one made after has it inside
  await until(
    async () =>
      (await messagesOf(session.panel, earlyBrief)).some(message => message.content.includes('**Tech news**')),
    'the section was added to the earlier brief',
  );
  const added = (await messagesOf(session.panel, earlyBrief)).find(message =>
    message.content.includes('**Tech news**'),
  );
  assert.ok(added.content.includes('Fake story one'));
  const laterBrief = await makeBrief(session.panel);
  const [body] = (await messagesOf(session.panel, laterBrief)).filter(message => message.actor === 'planner');
  assert.match(body.content, /\*\*Tech news\*\*\n- \*\*\[Fake story one\]/);

  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test('"New workflow" opens a new chat with the routine starter in the composer, focused', async () => {
  const session = await openSession(extension, mock);
  await openWorkflows(session);
  await session.panel.waitForSelector('[data-new-workflow]', { timeout: 10000 });
  await session.panel.evaluate(() => document.querySelector('[data-new-workflow]').click());
  await session.panel
    .waitForFunction(
      () => {
        const area = document.querySelector('textarea');
        return Boolean(area && area.value.startsWith('Create a routine that ') && document.activeElement === area);
      },
      { timeout: 10000 },
    )
    .catch(async error => {
      throw new Error(`${error.message}. Panel shows: ${(await session.panelText()).slice(0, 800)}`);
    });
  await session.close();
});
