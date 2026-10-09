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

const scenarios = {
  'kb-chat': [() => [{ done: { text: 'Scripted steps complete.', success: true } }]],
  'kb-agent': [
    () => [{ search_knowledge: { intent: 'Look in my notes', query: 'quote request gate fixture page' } }],
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
  await session.panel.evaluate(() =>
    document.querySelector('button[aria-label="Knowledge base"][aria-pressed]').click(),
  );
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
  // Back to the chat: the header's Knowledge base toggle, not the thread list button titled the same
  await session.panel.evaluate(() =>
    document.querySelector('button[aria-label="Knowledge base"][aria-pressed]').click(),
  );
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
  const options = await extension.browser.newPage();
  await options.goto(`${extension.origin}/options.html`);
  await options.waitForFunction(
    () => [...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'General'),
    {
      polling: 300,
      timeout: 10000,
    },
  );
  await options.evaluate(() =>
    [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'General').click(),
  );
  await options.waitForFunction(() => document.body.innerText.includes('Wipe the knowledge base'), {
    polling: 300,
    timeout: 10000,
  });
  await options.close();
  await session.close();
});
