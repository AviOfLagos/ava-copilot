import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end tests of the knowledge base: finished meetings and chats join it on their own, a
 * question gets an answer whose citations open the meeting at the right line, a saved page is found
 * by the agent, and export, wipe and import work. Embeddings come from the mock's Gemini endpoint.
 */

const DAY = 24 * 60 * 60 * 1000;

// WS1 Wave 2: the drawer's profile button opens a Radix dropdown menu, which reacts to
// `pointerdown` or a keyboard Enter/Space, not `click` — so the harness's own
// `session.click(label)` (a synthetic element.click() from evaluate()) never opens it. Puppeteer's
// native `ElementHandle.click()` is not a fix either: with this Brave build under CDP it hangs in
// `clickablePoint()`'s `Runtime.callFunctionOn` round trip until the default 180000ms
// `protocolTimeout`. This focuses the trigger and dispatches a real `keydown` for Enter instead,
// synthetically, inside one plain `evaluate()` call, same as every other click in this file.
// The profile menu opens through the harness: session.openAccountMenu()
const clickAccountMenu = session => session.openAccountMenu();

const scenarios = {
  'kb-chat': [() => [{ done: { text: 'Scripted steps complete.', success: true } }]],
  'kb-agent': [
    () => [{ search_knowledge: { intent: 'Look in my notes', query: 'quote request gate fixture page' } }],
    () => [{ done: { text: 'Scripted steps complete.', success: true } }],
  ],
  // Private and team memory: agent A keeps a note to itself, agent B and Ava look for it
  'mem-a-save': [
    () => [
      {
        save_to_knowledge: {
          intent: 'Keep it to myself',
          note: 'The Falcon launch codename is bluebird-e2e.',
          title: 'Falcon codename',
          team: false,
        },
      },
    ],
    () => [{ done: { text: 'Scripted steps complete.', success: true } }],
  ],
  'mem-search': [
    () => [{ search_knowledge: { intent: 'Look in memory', query: 'Falcon launch codename' } }],
    () => [{ done: { text: 'Scripted steps complete.', success: true } }],
  ],
};

let mock;
let extension;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
  // A Gemini provider whose embeddings come from the mock; the agents keep the scripted model
  const keys = await extension.getStorage('llm-api-keys');
  keys.providers.gemini = {
    name: 'Gemini',
    type: 'gemini',
    apiKey: 'test',
    baseUrl: mock.baseUrl.replace(/\/v1$/, '/v1beta'),
    modelNames: ['gemini-3.8-flash'],
    createdAt: Date.now(),
  };
  // Live captions would also use the Gemini provider; nothing here records a meeting
  await extension.setStorage({ 'llm-api-keys': keys });
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

/** Reads a whole object store of the extension's database, through an extension page. */
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

/** Writes records straight into the extension's database, as a finished recording would leave them. */
function writeStore(page, name, records) {
  return page.evaluate(
    (name, records) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(name, 'readwrite');
          for (const record of records) tx.objectStore(name).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    name,
    records,
  );
}

const background = (page, message) => page.evaluate(message => chrome.runtime.sendMessage(message), message);

async function waitForItem(page, predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const item = (await readStore(page, 'kbItems')).find(predicate);
    if (item) return item;
    await sleep(300);
  }
  throw new Error('The knowledge base never got the expected item');
}

async function openKnowledge(session) {
  await session.click('Menu');
  // WS1 Wave 2: Knowledge base and Settings moved from the drawer's top list into the profile menu
  await clickAccountMenu(session);
  await session.click('Knowledge base');
  await session.panel.waitForSelector('[role="tablist"][aria-label="Knowledge base"]', { timeout: 10000 });
}

async function ask(session, question) {
  // MorphOrb animates on animation frames, which a background tab does not get
  await session.panel.bringToFront();
  await session.panel.evaluate(text => {
    const input = document.querySelector('input[aria-label^="Ask about past"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, question);
  await sleep(100);
  await session.panel.evaluate(() => document.querySelector('.mo-send').click());
  await session.panel.waitForSelector('.mo-root[data-phase="answered"]', { timeout: 30000 });
  const answer = await session.panel.$eval('[role="group"][aria-label="Answer"]', el => el.innerText);
  const sources = await session.panel.$eval('section[aria-label="Sources"]', el => el.innerText).catch(() => '');
  return `${answer} ${sources}`.replace(/\s+/g, ' ');
}

test('a finished meeting joins the knowledge base, and an answer cites it at the line that was said', async () => {
  const session = await openSession(extension, mock);
  const meetingId = crypto.randomUUID();
  const startedAt = Date.now() - 2 * DAY;
  await writeStore(session.panel, 'meetings', [
    {
      id: meetingId,
      threadId: null,
      tabId: null,
      title: 'meet.google.com',
      platform: 'Google Meet',
      url: 'https://meet.google.com/abc',
      startedAt,
      endedAt: startedAt + 30 * 60 * 1000,
      status: 'done',
      source: 'audio',
      withMic: false,
      rollingSummary: '',
      summaryAt: 0,
      summaryUpTo: 0,
      blockSummaries: [],
      note: {
        title: 'Stage 2 sync',
        tldr: ['Stage 2 moves to Friday'],
        decisions: ['The Stage 2 deadline is Friday 10 October'],
        actionItems: [{ owner: 'Ada', task: 'Email the mentors about Stage 2', due: 'Thursday' }],
        openQuestions: [],
        participants: ['Ada'],
      },
      markdown: '# Stage 2 sync',
      warnings: [],
      liveCaptions: [],
      live: 'off',
      chunksTotal: 1,
      chunksDone: 1,
      error: null,
    },
  ]);
  await writeStore(session.panel, 'segments', [
    {
      id: crypto.randomUUID(),
      meetingId,
      tStart: 5,
      tEnd: 9,
      speaker: 'Ada',
      text: 'Welcome, everyone.',
      chunkIndex: 0,
    },
    {
      id: crypto.randomUUID(),
      meetingId,
      tStart: 724,
      tEnd: 730,
      speaker: 'Ada',
      text: 'So the Stage 2 deadline is Friday the tenth.',
      chunkIndex: 1,
    },
  ]);
  assert.deepEqual(await background(session.panel, { type: 'kb_sweep' }), { ok: true });

  const item = await waitForItem(session.panel, entry => entry.sourceId === meetingId);
  assert.equal(item.title, 'Stage 2 sync');
  assert.equal(item.unembedded, 0, 'every passage is embedded');
  assert.ok(
    mock.kb.embedded.some(text => text.includes('Stage 2 deadline')),
    'the meeting was embedded',
  );

  mock.kb.answer = 'The Stage 2 deadline is Friday 10 October [1][2].';
  await openKnowledge(session);
  const answer = await ask(session, 'What did we decide about Stage 2 deadlines last week?');
  assert.match(answer, /The Stage 2 deadline is Friday 10 October/);
  assert.match(answer, /Sources/i);
  assert.match(answer, /Stage 2 sync · Meeting/);
  const prompt = mock.kb.questions.at(-1);
  assert.match(prompt, /Meeting "Stage 2 sync", \d{4}-\d\d-\d\d \(\w+day\)/);
  assert.match(prompt, /at 12:04/);
  assert.match(prompt, /Question: What did we decide about Stage 2 deadlines last week\?/);

  // The source at 12:04 opens the meeting with that line in view
  const opened = await session.panel.evaluate(() => {
    const source = [...document.querySelectorAll('section[aria-label="Sources"] li button')].find(b =>
      b.innerText.includes('12:04'),
    );
    source?.click();
    return Boolean(source);
  });
  assert.ok(opened, 'the 12:04 source is listed');
  await session.panel.waitForFunction(
    () => [...document.querySelectorAll('li[id^="segment-"]')].some(li => li.className.includes('bg-primary')),
    { polling: 300, timeout: 10000 },
  );
  const focused = await session.panel.$eval('li[id^="segment-"][class*="bg-primary"]', el => el.innerText);
  assert.match(focused, /Stage 2 deadline is Friday the tenth/);
  assert.deepEqual(session.panelErrors, []);
  await session.close();
});

test('a chat joins the knowledge base when its task finishes', async () => {
  mock.start('kb-chat');
  const session = await openSession(extension, mock);
  await session.send('Run the scripted scenario kb-chat.');
  await session.waitForEnd();

  const item = await waitForItem(
    session.panel,
    entry => entry.sourceType === 'thread' && entry.title.includes('kb-chat'),
  );
  const chunks = (await readStore(session.panel, 'kbChunks')).filter(chunk => chunk.itemId === item.id);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /^User: Run the scripted scenario kb-chat\./);
  assert.match(chunks[0].text, /Copilot: E2E scenario finished\./);
  assert.doesNotMatch(chunks[0].text, /Clicking|Navigator/i, 'step logs are left out');
  await session.close();
});

test('a saved page is found by the agent with search_knowledge, and can be removed', async () => {
  const session = await openSession(extension, mock);
  await openKnowledge(session);
  // Save acts on the tab the user looks at
  await session.web.bringToFront();
  await session.click('Save this page');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Saved "Gate fixture"'), {
    polling: 300,
    timeout: 10000,
  });
  const page = await waitForItem(session.panel, entry => entry.sourceType === 'page');
  assert.equal(page.url, mock.fixtureUrl);

  mock.start('kb-agent');
  // Back to the chat, through the menu
  await session.click('Menu');
  await session.click('Home');
  await session.panel.waitForSelector('textarea', { timeout: 10000 });
  await session.send('Run the scripted scenario kb-agent.');
  await session.waitForEnd();
  const seen = mock.run.requests.join('\n');
  assert.match(seen, /Knowledge base results for "quote request gate fixture page"/);
  assert.match(seen, /Saved page "Gate fixture"/);
  assert.match(seen, /Quote request/);

  // Removing one item leaves the rest
  await openKnowledge(session);
  await session.panel.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')].find(tab => tab.innerText.startsWith('Saved')).click(),
  );
  await session.panel.waitForSelector('button[aria-label^="Remove"]', { timeout: 10000 });
  await session.click('Remove "Gate fixture" from the knowledge base');
  await session.panel.waitForFunction(() => !document.body.innerText.includes('Gate fixture'), {
    polling: 300,
    timeout: 10000,
  });
  const left = await readStore(session.panel, 'kbItems');
  assert.ok(!left.some(entry => entry.sourceType === 'page'));
  assert.ok(left.some(entry => entry.sourceType === 'meeting'));
  await session.close();
});

test('the knowledge base exports, wipes and imports back', async () => {
  const session = await openSession(extension, mock);
  const items = await readStore(session.panel, 'kbItems');
  const chunks = await readStore(session.panel, 'kbChunks');
  assert.ok(items.length >= 2);

  assert.deepEqual(await background(session.panel, { type: 'kb_wipe' }), { ok: true });
  assert.equal((await readStore(session.panel, 'kbItems')).length, 0);
  assert.equal((await readStore(session.panel, 'kbChunks')).length, 0);

  const bad = await background(session.panel, { type: 'kb_import', data: { format: 'something-else' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Not a knowledge base export/);

  const data = { format: 'avi-copilot-kb', version: 1, exportedAt: Date.now(), items, chunks };
  assert.deepEqual(await background(session.panel, { type: 'kb_import', data }), { ok: true, count: items.length });
  assert.equal((await readStore(session.panel, 'kbChunks')).length, chunks.length);

  // The settings page shows the section
  const options = await extension.openSettings('#memory/data');
  await options.waitForFunction(() => document.body.innerText.includes('Wipe the knowledge base'), {
    polling: 300,
    timeout: 10000,
  });
  await options.close();
  await session.close();
});

test('a saved page joins the knowledge graph, and the graph shows what it is linked to', async () => {
  mock.kb.graphReading = {
    people: ['Ada Lovelace'],
    organizations: [],
    projects: ['Quote requests'],
    decisions: [],
    actions: [{ task: 'Answer the quote requests', owner: 'Ada Lovelace' }],
  };
  const session = await openSession(extension, mock);
  await openKnowledge(session);
  await session.web.bringToFront();
  await session.click('Save this page');
  await waitForItem(session.panel, entry => entry.sourceType === 'page');

  // The page was read as data for the graph
  const deadline = Date.now() + 20000;
  while (!(await readStore(session.panel, 'graphNodes')).some(node => node.type === 'project')) {
    if (Date.now() > deadline) throw new Error('The graph never got the project');
    await sleep(300);
  }
  assert.ok(mock.kb.graphReads.some(text => /untrusted/i.test(text) && text.includes('Gate fixture')));

  await session.panel.bringToFront();
  await session.click('Graph');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Quote requests'), { polling: 300 });
  await session.click('Quote requests');
  await session.panel.waitForFunction(() => document.body.innerText.includes('Answer the quote requests'), {
    polling: 300,
  });
  assert.match(await session.panelText(), /Mentioned in/i);
  mock.kb.graphReading = { people: [], organizations: [], projects: [], decisions: [], actions: [] };
  await session.close();
});

test('an Obsidian vault gets the memory as linked notes, and its own notes join the knowledge base', async () => {
  const session = await openSession(extension, mock);
  // The browser's private folder stands in for the vault: the same kind of folder handle, already allowed
  await session.panel.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const vault = await root.getDirectoryHandle('vault', { create: true });
    const write = async (path, text) => {
      const parts = path.split('/');
      let folder = vault;
      for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
      const writable = await (await folder.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    };
    await write('Nexprove/Pitch notes.md', 'Investor pitch on Monday with Acme Ventures.');
    // A file of the user's own where the copilot would write: it must stay as it is
    await write('Nex Copilot/No workspace/Pages/Gate fixture.md', 'My own words');
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('avi-vault', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onsuccess = () => {
        const put = open.result.transaction('kv', 'readwrite').objectStore('kv').put(vault, 'handle');
        put.onsuccess = resolve;
        put.onerror = () => reject(put.error);
      };
    });
  });

  // Settings › Connections › Obsidian, on the full-page Settings
  const settings = await extension.openSettings('#connections/obsidian');
  await settings.waitForFunction(() => document.body.innerText.includes('Sync now'), { polling: 300 });
  await extension.clickOn(settings, 'Sync now');
  await settings.waitForFunction(() => /Wrote \d+ notes, read 1 of yours/.test(document.body.innerText), {
    polling: 300,
    timeout: 20000,
  });
  await settings.close();

  const imported = await waitForItem(session.panel, entry => entry.sourceId === 'vault:Nexprove/Pitch notes.md');
  assert.equal(imported.workspaceId, 'nexprove');
  const files = await session.panel.evaluate(async () => {
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('vault');
    const found = {};
    const walk = async (folder, prefix) => {
      for await (const [name, entry] of folder.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (entry.kind === 'directory') await walk(entry, path);
        else found[path] = await (await entry.getFile()).text();
      }
    };
    await walk(vault, '');
    return found;
  });
  const ours = Object.entries(files).filter(([path]) => path.startsWith('Nex Copilot/'));
  assert.ok(
    ours.some(([, text]) => text.includes('source: avi-copilot')),
    'the memory is written as notes',
  );
  assert.ok(
    ours.some(([path]) => /\/People\//.test(path)),
    'people get notes of their own',
  );
  assert.equal(files['Nex Copilot/No workspace/Pages/Gate fixture.md'], 'My own words');
  // The user's own note is never written back into the copilot's folder
  assert.ok(!ours.some(([path]) => path.includes('Pitch notes')));
  await session.close();
});

test('the morning brief comes as a chat with the priorities first, made from the data as untrusted', async () => {
  const session = await openSession(extension, mock);
  // Settings › Meetings & brief › Morning brief, on the full-page Settings; the brief opens in the panel
  const settings = await extension.openSettings('#meetings/brief');
  await settings.waitForFunction(() => document.body.innerText.includes('Make one now'), { polling: 300 });
  await extension.clickOn(settings, 'Make one now');
  await session.panel.bringToFront();
  await session.panel.waitForFunction(() => document.body.innerText.includes("Today's calendar"), {
    polling: 300,
    timeout: 20000,
  });
  const text = await session.panelText();
  assert.match(text, /First, today/);
  assert.match(text, /Reply to the waiting post/);
  assert.ok(text.indexOf('First, today') < text.indexOf("Today's calendar"));
  assert.ok(
    mock.kb.briefData.some(data => /untrusted/i.test(data)),
    'the data goes to the model as untrusted',
  );
  const brief = (await readStore(session.panel, 'threads')).find(thread => thread.tags.includes('brief'));
  assert.ok(brief, 'the brief is kept as a chat');
  await session.close();
});

/** Starts a run of an agent the way Run now does, over a port of its own from the panel page. */
function runAgent(page, id) {
  return page.evaluate(
    id =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'side-panel-connection' });
        const requestId = crypto.randomUUID();
        port.onMessage.addListener(message => {
          if (message.requestId !== requestId) return;
          port.disconnect();
          if (message.type === 'error') reject(new Error(message.error));
          else resolve(message.runId);
        });
        port.postMessage({ type: 'agents_run', id, requestId });
      }),
    id,
  );
}

async function untilRunEnds(page, runId, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const run = (await readStore(page, 'runs')).find(entry => entry.id === runId);
    if (run && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return run;
    await sleep(500);
  }
  throw new Error(`Run ${runId} never ended`);
}

test("an agent's private note: another agent's run cannot find it, Ava can, and sharing it with the team does", async () => {
  const session = await openSession(extension, mock);
  const now = Date.now();
  const agent = (id, name, scenario) => ({
    id,
    name,
    avatar: name[0],
    instructions: `Run the scripted scenario ${scenario}.`,
    skills: [],
    connectors: [],
    domains: ['127.0.0.1'],
    modelRole: 'fast',
    workspaceId: null,
    executor: 'browser',
    triggers: [{ type: 'manual' }],
    subscribes: [],
    publishes: [],
    budget: { dailyUsd: null, maxStepsPerRun: 20, runsPerDay: 20 },
    startUrl: mock.fixtureUrl,
    owns: [],
    enabled: true,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await writeStore(session.panel, 'agents', [
    agent('mem-agent-a', 'Memo A', 'mem-a-save'),
    agent('mem-agent-b', 'Memo B', 'mem-search'),
  ]);
  // What the model was sent while `work` ran, whichever scripted run the mock filed it under: search results
  // quote earlier chats that name other scenarios, which the mock follows
  const seenDuring = async work => {
    const all = () => [...mock.runs.values()].flatMap(run => run.requests);
    const before = new Set(all());
    await work();
    return all()
      .filter(request => !before.has(request))
      .join('\n');
  };
  const runB = () =>
    seenDuring(async () => {
      mock.start('mem-search');
      const run = await untilRunEnds(session.panel, await runAgent(session.panel, 'mem-agent-b'));
      assert.equal(run.status, 'succeeded');
    });

  // A keeps a note to itself: private, filed under A
  mock.start('mem-a-save');
  const saved = await untilRunEnds(session.panel, await runAgent(session.panel, 'mem-agent-a'));
  assert.equal(saved.status, 'succeeded');
  const note = await waitForItem(session.panel, entry => entry.title === 'Falcon codename');
  assert.equal(note.agentId, 'mem-agent-a');
  assert.equal(note.scope, 'private');

  // B's run searches for it and finds nothing of A's
  const byB = await runB();
  assert.match(byB, /Knowledge base results for|has nothing matching/);
  assert.doesNotMatch(byB, /bluebird-e2e/, "B never reads A's private note");

  // Ava, in the user's own chat, reads it
  const byAva = await seenDuring(async () => {
    mock.start('mem-search');
    await session.send('Run the scripted scenario mem-search.');
    await session.waitForEnd();
  });
  assert.match(byAva, /bluebird-e2e/, "Ava reads every agent's memory");

  // The user moves it to the team from the Knowledge base
  await openKnowledge(session);
  await session.panel.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')].find(tab => tab.innerText.startsWith('Saved')).click(),
  );
  await session.panel.waitForSelector('[data-scope="private"]', { timeout: 10000 });
  await session.click('Move "Falcon codename" to the team memory');
  await waitForItem(session.panel, entry => entry.id === note.id && entry.scope === 'team');
  await session.panel.waitForSelector('[data-scope="team"]', { timeout: 10000 });

  // Now B's run finds it
  assert.match(await runB(), /bluebird-e2e/, "the team memory is every agent's");
  await session.close();
});
