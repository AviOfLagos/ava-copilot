import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, restartServiceWorker, sleep } from './harness.mjs';

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
    // A made-up API for the routines the tests write themselves; /api/slow answers after five seconds
    const api = req.method === 'GET' && /^\/api\/(\w+)/.exec(req.url)?.[1];
    if (api) {
      seen.fetched.push(`api:${api}`);
      if (api === 'slow') await sleep(5000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ answer: api }));
    }
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
        'https://api.example.com/': `${proxy.origin}/api/`,
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

// ── From the 2026-10-16 audit: every test below but the restart one failed before its fix ──────────────

/** An extension page that talks to the background like the full-tab editor (one-off messages). */
async function editorPage() {
  const page = await extension.browser.newPage();
  await page.goto(`${extension.origin}/workflows.html`);
  return page;
}

const ask = (page, message) =>
  page.evaluate(message => chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() }), message);

function writeStore(page, name, records) {
  return page.evaluate(
    (name, records) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(name, 'readwrite');
          for (const record of records) tx.objectStore(name).put(record);
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    name,
    records,
  );
}

/** Saves a routine as a draft and clicks Create for it, as the panel does. */
async function createWorkflow(page, id, name, nodes, edges, allowHosts = []) {
  const now = Date.now();
  const spec = {
    v: 1,
    name,
    description: '',
    nodes,
    edges: edges.map(([from, to]) => ({ from, to })),
    allowHosts,
    budget: { maxSteps: 60, maxModelCalls: 10, maxTokens: 400000, maxRunsPerDay: 24 },
  };
  await writeStore(page, 'workflows', [
    {
      id,
      name,
      description: '',
      workspaceId: null,
      agentId: null,
      spec: null,
      version: 0,
      status: 'draft',
      failuresInRow: 0,
      lastRunAt: null,
      lastRunStatus: null,
      createdAt: now,
      updatedAt: now,
      draft: { spec, baseSpec: null, request: name, createdAt: now },
    },
  ]);
  const reply = await ask(page, { type: 'workflow_confirm', id });
  assert.equal(reply?.type, 'workflow_ok', JSON.stringify(reply));
}

const runsOf = async (page, workflowId) =>
  (await readStore(page, 'runs'))
    .filter(run => run.workflowId === workflowId)
    .sort((a, b) => a.startedAt - b.startedAt);

test('a hand edit after a run shows at once on the diagram, which the run still lights', async () => {
  const session = await openSession(extension, mock);
  await openWorkflows(session);
  await openWorkflow(session, 'Morning tech news');
  // The run of test 1 lights the diagram
  assert.ok((await diagram(session)).every(node => node.status === 'succeeded'));
  await session.panel.evaluate(() => document.querySelector('[data-flow-node="morning"]').click());
  await session.panel.waitForSelector('section[aria-label="Step Every morning"] input');
  await session.panel.evaluate(() => {
    const input = [...document.querySelectorAll('input')].find(item => item.value === '30 7 * * *');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0 8 * * *');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await session.click('Save');
  // Before the fix the diagram kept showing the last run's version (07:30) and the inspector went back to it
  await session.panel.waitForFunction(
    () => document.querySelector('[data-flow-node="morning"]')?.innerText.includes('08:00'),
    { polling: 300, timeout: 10000 },
  );
  assert.ok(
    (await diagram(session)).every(node => node.status === 'succeeded'),
    'the run still lights it',
  );
  assert.equal(
    await session.panel.evaluate(() =>
      [...document.querySelectorAll('input')].some(item => item.value === '0 8 * * *'),
    ),
    true,
  );
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test('the meeting-links routine reads as page triggers, laid out to fit the panel', async () => {
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 900 });
  await openWorkflows(session);
  await session.panel.evaluate(() =>
    document.querySelector('button[aria-label="Draft Meeting links from the template"]').click(),
  );
  await session.panel.waitForSelector('[data-flow-node="join"]', { timeout: 10000 });
  await session.click('Create');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Run now'), {
    polling: 300,
    timeout: 10000,
  });
  // Before: "By hand", and five cards in one row shrunk to a third of their size
  assert.match(await session.panelText(), /When one of 5 kinds of page opens/);
  const boxes = await session.panel.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-flow-node]')].map(node => {
        const box = node.getBoundingClientRect();
        return [node.dataset.flowNode, { x: Math.round(box.x), width: box.width }];
      }),
    ),
  );
  const triggers = Object.entries(boxes).filter(([id]) => id.startsWith('link_'));
  assert.equal(new Set(triggers.map(([, box]) => box.x)).size, 1, `one column: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.join.x > triggers[0][1].x, 'the join step is to their right');
  assert.ok(boxes.join.width > 188 * 0.6, `cards readable: ${boxes.join.width}px`);
  await session.click('Back to workflows');
  await session.panel.waitForSelector('[data-workflow="Meeting links"]');
  assert.match(await session.panelText(), /Meeting links Active When one of 5 kinds of page opens/);
  await session.close();
});

test('an offer nobody answered gives way to the next meeting link instead of hiding it', async () => {
  const page = await editorPage();
  const [workflow] = (await readStore(page, 'workflows')).filter(item => item.name === 'Meeting links');
  assert.ok(workflow, 'made in the test before');
  const meet = await extension.browser.newPage();
  await meet.setRequestInterception(true);
  // Never the real site: the meeting pages are answered here
  meet.on('request', request =>
    request.url().startsWith('https://meet.google.com/')
      ? request.respond({ status: 200, contentType: 'text/html', body: '<html><body><p>Lobby</p></body></html>' })
      : request.continue(),
  );
  await meet.goto('https://meet.google.com/abc-defg-hij');
  const [first] = await until(async () => {
    const runs = await runsOf(page, workflow.id);
    return runs.length === 1 && runs[0].status === 'waiting_user' ? runs : null;
  }, 'the first meeting offers to join');
  await meet.goto('https://meet.google.com/xyz-abcd-efg');
  const runs = await until(async () => {
    const list = await runsOf(page, workflow.id);
    return list.length === 2 && list[1].status === 'waiting_user' ? list : null;
  }, 'the second meeting offers to join too');
  assert.equal(runs[0].id, first.id);
  assert.equal(runs[0].status, 'cancelled');
  assert.match(runs[0].error.message, /newer run/);
  assert.match(runs[1].trigger.detail, /xyz-abcd-efg/);
  const offers = (await readStore(page, 'inbox')).filter(
    item => item.kind === 'approval' && item.source === `workflow:${workflow.id}`,
  );
  assert.deepEqual(offers.map(item => item.status).sort(), ['done', 'unread']);
  // Declined, so nothing joins
  assert.equal(
    (await ask(page, { type: 'workflow_step_answer', runId: runs[1].id, nodeId: 'join', approved: false })).type,
    'workflow_ok',
  );
  await ask(page, { type: 'workflow_pause', id: workflow.id, paused: true });
  await meet.close();
  await page.close();
});

test('a sandbox step without Nex Brain says so before asking for a click', async () => {
  const page = await editorPage();
  await createWorkflow(
    page,
    'wf-sandbox',
    'Build the site',
    [
      { id: 'go', type: 'trigger.manual', label: 'By hand' },
      { id: 'build', type: 'step.sandbox', label: 'Run the build', command: 'make' },
    ],
    [['go', 'build']],
  );
  const session = await openSession(extension, mock);
  await openWorkflows(session);
  await openWorkflow(session, 'Build the site');
  // The diagram says what it needs before anything runs
  assert.match(
    await session.panel.evaluate(() => document.querySelector('[data-flow-node="build"]').innerText),
    /Needs Nex Brain/,
  );
  await session.click('Run now');
  const [run] = await until(async () => {
    const runs = await runsOf(page, 'wf-sandbox');
    return runs[0]?.status === 'failed' ? runs : null;
  }, 'the run fails at once');
  // Before: it waited for "Hold to allow", and only then said Nex Brain was not paired
  assert.match(run.error.message, /Nex Brain.*Settings › Nex Brain/);
  assert.equal(
    (await readStore(page, 'inbox')).filter(item => item.source === 'workflow:wf-sandbox' && item.kind === 'approval')
      .length,
    0,
  );
  await session.panel.waitForFunction(() => document.body.innerText.includes('Settings › Nex Brain'), {
    polling: 300,
    timeout: 10000,
  });
  await session.close();
  await page.close();
});

test('a run cut off by a service worker restart carries on and finishes', async () => {
  const page = await editorPage();
  await createWorkflow(
    page,
    'wf-slow',
    'Slow source',
    [
      { id: 'go', type: 'trigger.manual', label: 'By hand' },
      {
        id: 'fetch',
        type: 'step.http_get',
        label: 'Slow API',
        url: 'https://api.example.com/slow',
        format: 'json',
        maxBytes: 10000,
      },
      {
        id: 'note',
        type: 'out.inbox',
        label: 'Note',
        title: 'Slow: {{steps.fetch.output}}',
        body: '',
        priority: 'low',
      },
    ],
    [
      ['go', 'fetch'],
      ['fetch', 'note'],
    ],
    ['api.example.com'],
  );
  assert.equal((await ask(page, { type: 'workflow_run', id: 'wf-slow' })).type, 'workflow_ok');
  await until(async () => (await runsOf(page, 'wf-slow'))[0]?.status === 'running', 'the run started');
  await sleep(1000);
  await restartServiceWorker(extension, page);
  const [run] = await until(
    async () => {
      const runs = await runsOf(page, 'wf-slow');
      return runs[0]?.status === 'succeeded' ? runs : null;
    },
    'the run finished after the restart',
    120000,
  );
  assert.equal(run.status, 'succeeded');
  assert.ok((await readStore(page, 'inbox')).some(item => item.title.includes('"answer":"slow"')));
  await page.close();
});

test('"New workflow" in the full tab drafts a routine from the words typed there', async () => {
  const page = await editorPage();
  await page.setViewport({ width: 1100, height: 900 });
  await page.waitForSelector('[data-new-workflow]');
  const before = proxy.seen.authoring.length;
  await page.evaluate(() => document.querySelector('[data-new-workflow]').click());
  // Before: nothing happened (it wanted a chat, and this page has none)
  await page.waitForSelector('[data-describe-workflow] textarea', { timeout: 10000 });
  await page.evaluate(text => {
    const area = document.querySelector('[data-describe-workflow] textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }, REQUEST);
  await page.evaluate(() =>
    [...document.querySelectorAll('[data-describe-workflow] button')]
      .find(b => b.innerText.trim() === 'Draft it')
      .click(),
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-flow-node][data-change="added"]').length === 5, {
    polling: 300,
    timeout: 30000,
  });
  assert.equal(proxy.seen.authoring.length, before + 1);
  assert.ok(proxy.seen.authoring.at(-1).includes(REQUEST));
  assert.match(await page.evaluate(() => document.body.innerText), /Create/);
  await page.close();
});
