import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of "Bring in your AI history": a synthetic folder of Claude Code, Codex and ChatGPT
 * history is picked (the browser's private folder stands in for the picker), its conversations join the
 * knowledge base in the right workspaces with secrets taken out, a second pass reads nothing new, each
 * workspace's summary reads only its own items, the all-workspaces roll-up lists both, the agent pulls
 * the summary with workspace_context, and the morning brief carries the roll-up.
 *
 * Everything here is made up for the test. SCREENS=<dir> saves ~400 px screenshots.
 */

const SCREENS = process.env.SCREENS;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = ago => new Date(now - ago).toISOString();
// A fake key, built from pieces so no scanner mistakes it for a leak
const FAKE_KEY = 'sk-' + 'ant-' + 'api03-' + 'FAKEFAKEFAKEFAKEFAKEFAKE1234';

const workspaces = [
  { id: 'acme', name: 'Acme', about: 'A rocket company.', keywords: ['rocket'], accounts: {}, createdAt: 1 },
  { id: 'fest', name: 'Tech Fest', about: 'A conference.', keywords: ['fest', 'speakers'], accounts: {}, createdAt: 2 },
];

const claudeLines = [
  { type: 'ai-title', sessionId: 'c1', aiTitle: 'Acme pricing page' },
  {
    type: 'user',
    sessionId: 'c1',
    cwd: '/Users/tester/code/acme-site',
    gitBranch: 'main',
    timestamp: iso(DAY),
    message: { role: 'user', content: `Ship the pricing page. My key is ${FAKE_KEY}` },
  },
  {
    type: 'assistant',
    sessionId: 'c1',
    cwd: '/Users/tester/code/acme-site',
    timestamp: iso(DAY - 60_000),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Shipped the pricing page at $20 a seat.' }] },
  },
];
const codexLines = [
  {
    type: 'session_meta',
    timestamp: iso(2 * DAY),
    payload: { id: 'x1', cwd: '/Users/tester/code/fest-app', git: { branch: 'speakers' }, timestamp: iso(2 * DAY) },
  },
  {
    type: 'response_item',
    timestamp: iso(2 * DAY),
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build the speaker list page' }] },
  },
  {
    type: 'response_item',
    timestamp: iso(2 * DAY - 60_000),
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Speaker list is live.' }] },
  },
];
const chatgpt = [
  {
    id: 'g1',
    title: 'Sourdough timing',
    create_time: (now - 3 * DAY) / 1000,
    update_time: (now - 3 * DAY) / 1000,
    current_node: 'b',
    mapping: {
      a: {
        parent: null,
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['How long to proof sourdough?'] },
        },
      },
      b: {
        parent: 'a',
        message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['About 4 hours.'] } },
      },
    },
  },
];

const scenarios = {
  'history-agent': [
    () => [{ workspace_context: { intent: 'Read where Acme is at', query: 'pricing' } }],
    () => [{ done: { text: 'Scripted steps complete.', success: true } }],
  ],
};

let mock;
let extension;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
  await extension.setStorage({
    workspaces: { items: workspaces, seeded: true, defaultWorkspaceId: null, defaultWorkspaceMigrated: true },
  });
  if (SCREENS) fs.mkdirSync(SCREENS, { recursive: true });
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

function readStore(page, name) {
  return page.evaluate(
    name =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction(name).objectStore(name).getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        };
      }),
    name,
  );
}

const sessionsIn = async page => (await readStore(page, 'kbItems')).filter(item => item.sourceType === 'ai-session');

async function waitForText(page, pattern, timeout = 20000) {
  await page.waitForFunction(
    source => new RegExp(source, 'i').test(document.body.innerText),
    { polling: 300, timeout },
    pattern.source,
  );
}

async function screenshot(session, name) {
  if (!SCREENS) return;
  await session.panel.bringToFront();
  await session.panel.setViewport({ width: 400, height: 860 });
  await sleep(300);
  await session.panel.screenshot({ path: path.join(SCREENS, `${name}.png`) });
}

/** Settings › Memory › AI history lives on the full-page Settings: the session's page goes there. */
async function openSettings(session) {
  await session.panel.goto(`${extension.origin}/options.html#memory/history`);
  await waitForText(session.panel, /Bring in your AI history/);
  // The folder picker answers with the folder the test wrote (the stub did not survive the page change)
  await session.panel.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('history');
  });
}

test('a picked folder of AI history joins the knowledge base, routed, redacted, and read again only when changed', async () => {
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 860 });
  await session.panel.evaluate(
    async (claude, codex, exportJson) => {
      const root = await navigator.storage.getDirectory();
      const history = await root.getDirectoryHandle('history', { create: true });
      const write = async (filePath, text) => {
        const parts = filePath.split('/');
        let folder = history;
        for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
        const writable = await (await folder.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
      };
      await write('.claude/projects/-Users-tester-code-acme-site/0b1c2d3e-1111-2222-3333-444455556666.jsonl', claude);
      await write('.claude/projects/-Users-tester-code-acme-site/memory/MEMORY.jsonl', '{"type":"user"}');
      await write('.codex/sessions/2026/10/12/rollout-2026-10-12T09-00-00-x1.jsonl', codex);
      await write('chatgpt-export/conversations.json', exportJson);
      // The folder picker answers with that folder
      window.showDirectoryPicker = async () => history;
    },
    claudeLines.map(line => JSON.stringify(line)).join('\n'),
    codexLines.map(line => JSON.stringify(line)).join('\n'),
    JSON.stringify(chatgpt),
  );

  await openSettings(session);
  await session.click('Add a folder');
  await waitForText(session.panel, /Brought in 3 new and 0 updated conversations\./);
  assert.match(await session.panelText(), /Secrets taken out: 1\./);

  const items = await sessionsIn(session.panel);
  const byTitle = Object.fromEntries(items.map(item => [item.title, item]));
  assert.equal(byTitle['Acme pricing page'].workspaceId, 'acme', 'routed by its project folder');
  assert.equal(byTitle['Build the speaker list page'].workspaceId, 'fest');
  assert.equal(byTitle['Sourdough timing'].workspaceId ?? null, null, 'nothing names a workspace: general');
  assert.deepEqual(byTitle['Acme pricing page'].origin, {
    tool: 'claude-code',
    project: '/Users/tester/code/acme-site',
    importId: byTitle['Acme pricing page'].origin.importId,
  });
  const chunks = await readStore(session.panel, 'kbChunks');
  const stored = chunks.map(chunk => chunk.text).join('\n');
  assert.ok(!stored.includes(FAKE_KEY), 'the key never reaches the knowledge base');
  assert.match(stored, /\[redacted: API key\]/);
  assert.match(stored, /Claude Code session in \/Users\/tester\/code\/acme-site \(branch main\)/);
  assert.doesNotMatch(stored, /MEMORY/);

  // Per workspace, and the projects to map
  const text = await session.panelText();
  assert.match(text, /Acme · 1/);
  assert.match(text, /Tech Fest · 1/);
  assert.match(text, /Claude Code/);
  assert.match(text, /Codex/);
  await session.panel.evaluate(() =>
    document.querySelector('section[aria-label="Bring in your AI history"]').scrollIntoView({ block: 'start' }),
  );
  await screenshot(session, 'history-settings');

  // A second pass reads nothing that did not change
  await session.panel.evaluate(() =>
    [...document.querySelectorAll('[role="group"][aria-label="Import from history"] button')]
      .find(button => button.innerText.trim() === 'Update')
      .click(),
  );
  await waitForText(session.panel, /Brought in 0 new and 0 updated conversations\./);
  assert.equal((await sessionsIn(session.panel)).length, 3);

  // Mapping a project folder moves its sessions
  await session.panel.evaluate(() => {
    const select = document.querySelector('select[aria-label="Workspace for /Users/tester/code/fest-app"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'acme');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const deadline = Date.now() + 10000;
  while (
    (await sessionsIn(session.panel)).find(item => item.title === 'Build the speaker list page').workspaceId !== 'acme'
  ) {
    if (Date.now() > deadline) throw new Error('The mapped project never moved');
    await sleep(300);
  }
  // And back, for the tests that follow
  await session.panel.evaluate(() => {
    const select = document.querySelector('select[aria-label="Workspace for /Users/tester/code/fest-app"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'fest');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  while (
    (await sessionsIn(session.panel)).find(item => item.title === 'Build the speaker list page').workspaceId !== 'fest'
  ) {
    if (Date.now() > deadline + 10000) throw new Error('The mapped project never moved back');
    await sleep(300);
  }
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test("each workspace's summary reads only its own items, and the all-workspaces view lists both", async () => {
  const session = await openSession(extension, mock);
  mock.kb.summaries.length = 0;
  const reply = await session.panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'history_summarize', force: true, requestId: 'r1' }),
  );
  assert.equal(reply.type, 'history_ok');

  const acme = mock.kb.summaries.find(prompt => prompt.includes('Workspace: Acme'));
  const fest = mock.kb.summaries.find(prompt => prompt.includes('Workspace: Tech Fest'));
  assert.ok(acme && fest, 'one summary per workspace');
  assert.match(acme, /Acme pricing page/);
  assert.doesNotMatch(acme, /speaker list|Sourdough/i, "no other workspace's text in Acme's summary");
  assert.match(fest, /speaker list/i);
  assert.doesNotMatch(fest, /pricing|Sourdough/i);
  assert.ok(!mock.kb.summaries.join('\n').includes(FAKE_KEY));
  assert.match(acme, /nano_untrusted_content/);

  await session.openKnowledge();
  await session.panel.setViewport({ width: 400, height: 860 });
  await session.click('Where we are');
  await waitForText(session.panel, /Across your workspaces/);
  const rollup = await session.panelText();
  assert.match(rollup, /Acme.*Latest: Acme pricing page/);
  assert.match(rollup, /Tech Fest.*Latest: Build the speaker list page/);
  assert.match(rollup, /Follow up on Acme pricing page \(by 2026-10-20\)/);
  await screenshot(session, 'history-rollup');

  // One workspace: its summary with its sources only
  await session.click('Acme');
  await waitForText(session.panel, /Where Acme is at/);
  const summary = await session.panelText();
  assert.match(summary, /Working on Acme pricing page \[1\]/);
  assert.match(summary, /\[1\] Acme pricing page/);
  assert.doesNotMatch(summary, /speaker list/i);
  await screenshot(session, 'history-summary');
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test('the agent pulls the workspace summary with workspace_context, scoped to the workspace', async () => {
  mock.start('history-agent');
  const session = await openSession(extension, mock);
  await session.send('Run the scripted scenario history-agent: where are we at with Acme?');
  await session.waitForEnd();
  const seen = mock.run.requests.join('\n');
  assert.match(seen, /Where we are in "Acme"/);
  assert.match(seen, /Working on Acme pricing page/);
  assert.match(seen, /Passages in "Acme" matching "pricing"/);
  assert.doesNotMatch(seen, /Speaker list is live|Sourdough/, "nothing from another workspace's items");
  await session.close();
});

test('the morning brief carries every workspace’s latest activity and next actions', async () => {
  const session = await openSession(extension, mock);
  const { threadId } = await session.panel.evaluate(() => chrome.runtime.sendMessage({ type: 'brief_make' }));
  assert.ok(threadId);
  const messages = (await readStore(session.panel, 'messages')).filter(message => message.threadId === threadId);
  const brief = messages.map(message => message.content).join('\n');
  assert.match(brief, /\*\*Across your workspaces\*\*/);
  assert.match(brief, /\*\*Acme\*\*: latest "Acme pricing page"/);
  assert.match(brief, /\*\*Tech Fest\*\*: latest "Build the speaker list page"/);
  assert.match(brief, /- \[ \] Follow up on Acme pricing page \(by 2026-10-20\)/);
  await session.close();
});

test('forgetting an import removes its conversations', async () => {
  const session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 860 });
  await openSettings(session);
  await session.panel.waitForSelector('button[aria-label="Forget the import from history"]', { timeout: 10000 });
  await session.click('Forget the import from history');
  await session.click('Remove 3 conversations?');
  await waitForText(session.panel, /Forgot the import: 3 conversations left the knowledge base\./);
  assert.equal((await sessionsIn(session.panel)).length, 0);
  await session.close();
});
