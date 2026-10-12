import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end test of agents: the user asks in chat for an agent, the chat drafts it with a separate structured
 * call, the panel shows the draft and Create turns it on; Run now runs its task in the agents' own window
 * (never the user's tab, never taking the focus); the run log shows its steps; and a page the user opens that
 * matches its watched pattern wakes it again, tainted.
 *
 * A small proxy sits in front of the scripted model: it answers the agent-drafting call itself (recognised
 * by its instructions) and passes everything else to mock-llm.mjs.
 */

const AUTHORING_MARKER = 'You design agents for Avi Copilot';
const REQUEST = 'Make an agent that fills in the quote form on the fixture page when I open it with watch';
const AGENT_NAME = 'Fixture scout';

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const typeName = name => page => [
  { input_text: { intent: 'Fill the name', index: page.find('input', 'name'), text: name } },
];
const scenarios = {
  'agent-create': [() => [{ create_agent: { intent: 'Draft the agent', request: REQUEST } }], done],
  // What the agent itself does on each run, in its own tab
  'agent-run': [typeName('Scout'), done],
};

// The agent as the scripted model drafts it, in the flat shape the structured call asks for
const authored = fixtureUrl => ({
  name: AGENT_NAME,
  avatar: '🔭',
  instructions: 'Run the scripted scenario agent-run. Fill the name field on the fixture page, then say what you did.',
  modelRole: 'fast',
  startUrl: fixtureUrl,
  domains: ['127.0.0.1'],
  triggers: [
    { type: 'manual', value: '' },
    { type: 'tab', value: '127.0.0.1:*/fixture.html?watch=*' },
  ],
  publishes: [],
  skills: [],
  dailyUsd: 1,
  maxStepsPerRun: 30,
  runsPerDay: 10,
});

const textOf = message =>
  typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map(part => part.text ?? '').join('\n')
      : '';

function reply(res, request, content) {
  const payload = JSON.stringify(content);
  const tool = request.tools?.[0]?.function?.name;
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
      id: 'chatcmpl-agents',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    }),
  );
}

async function startProxy(mock) {
  const seen = { authoring: [] };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      const request = JSON.parse(body);
      const instructions = request.messages
        .filter(message => message.role === 'system' || message.role === 'developer')
        .map(textOf)
        .join('\n');
      if (instructions.includes(AUTHORING_MARKER)) {
        seen.authoring.push(
          request.messages
            .filter(message => message.role === 'user')
            .map(textOf)
            .join('\n'),
        );
        return reply(res, request, authored(mock.fixtureUrl));
      }
    }
    // Everything else is the scripted chat and the fixture page
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
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
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
});

after(async () => {
  await extension?.close();
  await proxy?.close();
  await mock?.close();
});

/** Where a run's browser task works: its chat, and the tab and window the chat is bound to. */
async function runPlace(page, run) {
  const steps = (await readStore(page, 'runSteps')).filter(step => step.runId === run.id);
  const threadId = steps.find(step => step.nodeId === 'task')?.state?.threadId;
  const thread = (await readStore(page, 'threads')).find(item => item.id === threadId);
  const tab = await page.evaluate(tabId => chrome.tabs.get(tabId).catch(() => null), thread?.boundTabIds?.[0]);
  return { thread, tab };
}

const agentRuns = async (page, agentId) =>
  (await readStore(page, 'runs'))
    .filter(run => run.kind === 'agent' && run.agentId === agentId)
    .sort((a, b) => a.startedAt - b.startedAt);

test('an agent asked for in chat: draft, create, run in its own window, run log, and a watched page', async () => {
  const session = await openSession(extension, mock);
  const fixtureUrl = session.web.url();

  // 1. Asked for in chat: the chat drafts it with a separate structured call; nothing runs yet
  mock.start('agent-create');
  await session.send(`Run the scripted scenario agent-create. ${REQUEST}`);
  await session.waitForEnd(90000);
  assert.equal(proxy.seen.authoring.length, 1, 'one agent-drafting call');
  assert.ok(proxy.seen.authoring[0].includes(REQUEST), 'the user words reached the agent writer');
  const [draft] = await until(async () => {
    const agents = await readStore(session.panel, 'agents');
    return agents.length ? agents : null;
  }, 'the draft was saved');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.draft.profile.name, AGENT_NAME);
  assert.deepEqual(await agentRuns(session.panel, draft.id), [], 'a draft never runs');

  // 2. The panel shows the draft with what it would do, and Create turns it on
  await session.panel.bringToFront();
  await session.click('Menu');
  await session.click('Agents');
  await session.panel
    .waitForFunction(() => document.querySelector('#agents-templates') !== null, { polling: 300, timeout: 10000 })
    .catch(async error => {
      throw new Error(`${error.message}. Panel shows: ${(await session.panelText()).slice(0, 800)}`);
    });
  await session.panel.evaluate(name => document.querySelector(`[data-agent="${name}"]`).click(), AGENT_NAME);
  await session.panel.waitForSelector('[data-agent-draft]', { timeout: 10000 });
  const draftText = await session.panelText();
  // The heading is set in small capitals
  assert.match(draftText, /New agent — check it/i);
  assert.match(draftText, /Drafts never run/);
  assert.match(draftText, /When a page matching 127\.0\.0\.1:\*\/fixture\.html\?watch=\* opens/);
  await session.click('Create');
  const agent = await until(async () => {
    const [stored] = await readStore(session.panel, 'agents');
    return stored.status === 'active' && !stored.draft ? stored : null;
  }, 'Create turned it on');
  assert.equal(agent.enabled, true);

  // 3. Run now: its task runs in the agents' window, never in the user's tab, and never takes the focus.
  // The user is on the fixture page (the harness's panel is a tab; a click on it needs no focus)
  await session.web.bringToFront();
  const before = await session.panel.evaluate(async url => {
    const tabs = await chrome.tabs.query({});
    const fixture = tabs.find(tab => tab.url === url);
    const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    return { tabId: fixture.id, windowId: fixture.windowId, active: fixture.active, focusedWindowId: focused.id };
  }, fixtureUrl);
  assert.equal(before.active, true, 'the fixture tab is the one the user is on');
  mock.start('agent-run');
  await session.click('Run now');
  const [first] = await until(async () => {
    const runs = await agentRuns(session.panel, agent.id);
    return runs.length && runs[0].status !== 'queued' ? runs : null;
  }, 'the run started');
  const firstPlace = await until(async () => {
    const place = await runPlace(session.panel, first);
    return place.tab ? place : null;
  }, 'the run has a tab');
  assert.equal(firstPlace.thread.origin, 'agent');
  assert.equal(firstPlace.thread.agentId, agent.id);
  assert.notEqual(firstPlace.tab.windowId, before.windowId, 'the agent works in a window of its own');
  assert.notEqual(firstPlace.tab.id, before.tabId);

  const ended = await until(
    async () => {
      const run = (await agentRuns(session.panel, agent.id))[0];
      return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status) ? run : null;
    },
    'the run ended',
    90000,
  );
  assert.equal(ended.status, 'succeeded', `the run succeeded: ${JSON.stringify(ended.error)}`);
  assert.equal(ended.tainted, false, 'a run the user started is not tainted');
  const after = await session.panel.evaluate(async tabId => {
    const fixture = await chrome.tabs.get(tabId);
    const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const agentWindow = (await chrome.storage.session.get('agent-window'))['agent-window'];
    return { active: fixture.active, focusedWindowId: focused.id, agentWindowId: agentWindow?.windowId };
  }, before.tabId);
  assert.equal(after.active, true, "the user's tab is still the active one");
  assert.equal(after.focusedWindowId, before.focusedWindowId, 'the focus stayed where it was');
  assert.equal(after.agentWindowId, firstPlace.tab.windowId);
  assert.equal(await session.web.$eval('#name', el => el.value), '', "the user's own page was never touched");

  // 4. The run log shows what it did: the trigger, its action, its model calls and the end
  await session.panel.bringToFront();
  await session.panel.waitForFunction(
    () => {
      const log = document.querySelector('[data-run-log]');
      return (
        log &&
        log.querySelector('[data-log-kind="action"]') &&
        log.querySelector('[data-log-kind="model"]') &&
        log.querySelector('[data-log-kind="end"]')
      );
    },
    { polling: 300, timeout: 20000 },
  );
  const logText = await session.panel.evaluate(() => document.querySelector('[data-run-log]').innerText);
  assert.match(logText, /Fill the name/);
  assert.match(logText, /Model call/);
  assert.match(logText, /Succeeded/i);

  // 5. A page the user opens that matches its pattern wakes it again, on its own copy, tainted
  mock.start('agent-run');
  const watched = await extension.browser.newPage();
  await watched.goto(`${fixtureUrl}?watch=1`);
  const tabRun = await until(
    async () => {
      const run = (await agentRuns(session.panel, agent.id)).find(item => item.trigger.type === 'tab');
      return run && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status) ? run : null;
    },
    'the watched page woke the agent',
    90000,
  );
  assert.equal(tabRun.status, 'succeeded', `the tab run succeeded: ${JSON.stringify(tabRun.error)}`);
  assert.equal(tabRun.tainted, true, 'a run a page set off is tainted');
  assert.match(tabRun.trigger.detail, /fixture\.html\?watch=1/);
  assert.match(tabRun.spec.startUrl, /fixture\.html\?watch=1/);
  const tabPlace = await runPlace(session.panel, tabRun);
  assert.equal(tabPlace.tab?.windowId, after.agentWindowId, 'it works in the agents window again');
  assert.equal(await watched.$eval('#name', el => el.value), '', 'the page the user opened was never touched');
  const runs = await agentRuns(session.panel, agent.id);
  assert.equal(runs.length, 2, 'one run per firing');

  assert.deepEqual(session.panelErrors, []);
  await watched.close();
  await session.close();
});

test('"New agent" opens a new chat with the agent starter in the composer, focused', async () => {
  const session = await openSession(extension, mock);
  await session.panel.bringToFront();
  await session.click('Menu');
  await session.click('Agents');
  await session.panel.waitForSelector('[data-new-agent]', { timeout: 10000 });
  await session.panel.evaluate(() => document.querySelector('[data-new-agent]').click());
  await session.panel
    .waitForFunction(
      () => {
        const area = document.querySelector('textarea');
        return Boolean(area && area.value.startsWith('Create an agent that ') && document.activeElement === area);
      },
      { timeout: 10000 },
    )
    .catch(async error => {
      throw new Error(`${error.message}. Panel shows: ${(await session.panelText()).slice(0, 800)}`);
    });
  await session.close();
});
