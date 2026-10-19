import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, readThreads, sleep } from './harness.mjs';

/**
 * End-to-end tests of the confirm gate: the real extension in a real browser, acting on the fixture
 * page, with the model replaced by a script. The scripted model never sets "commits" unless a test
 * says so, so what these tests prove is the gate's own reading of the page.
 */

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];

const scenarios = {
  'form-submit': [
    page => [
      { input_text: { intent: 'Fill the name', index: page.find('input', 'name'), text: 'Ada Lovelace' } },
      { input_text: { intent: 'Fill the notes', index: page.find('textarea', 'notes'), text: 'Two rooms' } },
    ],
    page => [{ click_element: { intent: 'Submit the form', index: page.find('button', 'Request a quote') } }],
    done,
  ],
  'send-button': [
    page => [
      {
        input_text: {
          intent: 'Write the message',
          index: page.find('div', 'role=textbox'),
          text: 'Hello team\nSecond line',
        },
      },
    ],
    page => [{ click_element: { intent: 'Send it', index: page.find('div', 'Send message') } }],
    done,
  ],
  'enter-in-composer': [
    page => [
      { input_text: { intent: 'Write the message', index: page.find('div', 'role=textbox'), text: 'Quick note' } },
    ],
    () => [{ send_keys: { intent: 'Send with Enter', keys: 'Enter' } }],
    done,
  ],
  'enter-in-form-field': [
    page => [{ input_text: { intent: 'Fill the name', index: page.find('input', 'name'), text: 'Grace Hopper' } }],
    () => [{ send_keys: { intent: 'Submit with Enter', keys: 'Enter' } }],
    done,
  ],
  'declared-by-model': [
    page => [{ click_element: { intent: 'Engage the thing', index: page.find('div', 'Engage'), commits: true } }],
    done,
  ],
  'harmless-clicks': [
    page => [{ click_element: { intent: 'Open the menu', index: page.find('button', 'Open menu') } }],
    page => [{ click_element: { intent: 'Engage', index: page.find('div', 'Engage') } }],
    done,
  ],
  'type-password': [
    page => [{ input_text: { intent: 'Type the password', index: page.find('input', 'password'), text: 'hunter2' } }],
    done,
  ],
  'form-fill-once': [
    // What it knows goes in at once; what it does not is asked in one card
    page => [
      {
        fill_form: {
          intent: 'Fill the quote form',
          fields: [{ index: page.find('input', 'name'), value: 'Ada Lovelace' }],
          questions: ['What should the notes say?', 'Any company name?'],
        },
      },
    ],
    page => [
      {
        fill_form: { intent: 'Fill the rest', fields: [{ index: page.find('textarea', 'notes'), value: 'Two rooms' }] },
      },
    ],
    page => [{ click_element: { intent: 'Submit the form', index: page.find('button', 'Request a quote') } }],
    done,
  ],
  // Cancel on the confirm card stops the task; the chat must settle and take the next message
  'cancel-settles': [
    page => [{ input_text: { intent: 'Fill the name', index: page.find('input', 'name'), text: 'Ada Lovelace' } }],
    page => [
      {
        click_element: {
          intent: 'Payment link so clients can pay in one tap',
          index: page.find('button', 'Request a quote'),
        },
      },
    ],
    done,
  ],
  'after-cancel': [done],
  // Stop pressed while the agent's questions wait on the card
  'question-stop': [
    page => [
      {
        fill_form: {
          intent: 'Payment link so clients can pay in one tap',
          fields: [{ index: page.find('input', 'name'), value: 'Ada Lovelace' }],
          questions: ['Which payment link should clients use?'],
        },
      },
    ],
    done,
  ],
  'type-login-email': [
    page => [{ input_text: { intent: 'Type the email', index: page.find('input', 'email'), text: 'ada@example.com' } }],
    done,
  ],
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

async function run(name) {
  mock.start(name);
  const session = await openSession(extension, mock);
  await session.send(`Run the scripted scenario ${name}.`);
  return session;
}

// A script that could not find its element would make a test pass or fail for the wrong reason
async function finish(session) {
  assert.deepEqual(mock.run.errors, [], 'the scripted model ran without errors');
  assert.deepEqual(session.panelErrors, [], 'the side panel threw no errors');
  await session.close();
}

test('a form submit waits for approval and shows the form content', async () => {
  const session = await run('form-submit');
  const card = await session.waitForCard();

  assert.match(card, /Confirm: Submit a form/);
  assert.match(card, /Request a quote/);
  assert.match(card, /Ada Lovelace/);
  assert.match(card, /Two rooms/);
  assert.deepEqual(await session.events(), [], 'nothing is submitted while the card is up');

  await session.answer('Confirm');
  const text = await session.waitForEnd();

  assert.deepEqual(await session.events(), [{ type: 'quote', name: 'Ada Lovelace', notes: 'Two rooms' }]);
  assert.match(text, /Checked: the text now shows on the page/);
  await finish(session);
});

test('a Send button outside any form waits for approval, and multi-line text does not send itself', async () => {
  const session = await run('send-button');
  const card = await session.waitForCard();

  assert.match(card, /Confirm: Send a message/);
  assert.match(card, /Hello team/);
  assert.match(card, /Second line/);
  assert.deepEqual(await session.events(), [], 'typing a line break must not press Enter');

  await session.answer('Confirm');
  const text = await session.waitForEnd();

  assert.deepEqual(await session.events(), [{ type: 'sent', text: 'Hello team\nSecond line' }]);
  assert.match(text, /Checked: the text now shows on the page/);
  await finish(session);
});

test('Enter in a chat composer waits for approval, and Cancel sends nothing', async () => {
  const session = await run('enter-in-composer');
  const card = await session.waitForCard();

  assert.match(card, /Confirm: Send a message/);
  assert.match(card, /Quick note/);

  await session.answer('Cancel');
  await session.waitForEnd();
  await sleep(1500);

  assert.deepEqual(await session.events(), []);
  assert.equal(await session.web.$eval('#composer', el => el.innerText.trim()), 'Quick note');
  assert.equal(mock.run.step, 2, 'the agent takes no further step after a refusal');
  await finish(session);
});

test('Enter in a form field waits for approval', async () => {
  const session = await run('enter-in-form-field');
  const card = await session.waitForCard();

  assert.match(card, /Confirm: Submit a form/);
  assert.match(card, /Grace Hopper/);

  await session.answer('Cancel');
  await session.waitForEnd();
  await sleep(1500);
  assert.deepEqual(await session.events(), []);
  await finish(session);
});

test('an action the model declares as a commit waits for approval, whatever its label', async () => {
  const session = await run('declared-by-model');
  await session.waitForCard();
  assert.deepEqual(await session.events(), []);

  await session.answer('Confirm');
  await session.waitForEnd();
  assert.deepEqual(await session.events(), [{ type: 'engage' }]);
  await finish(session);
});

test('clicks that commit nothing run without asking', async () => {
  const session = await run('harmless-clicks');
  const text = await session.waitForEnd();

  assert.deepEqual(await session.events(), [{ type: 'menu' }, { type: 'engage' }]);
  assert.doesNotMatch(text, /Waiting for you/);
  await finish(session);
});

test('a password is never typed; the step is handed to the user', async () => {
  const session = await run('type-password');
  const card = await session.waitForCard();

  assert.match(card, /Your turn/);
  assert.match(card, /sign in/i);

  await session.answer('Stop');
  await session.waitForEnd();
  assert.equal(await session.web.$eval('#password', el => el.value), '');
  await finish(session);
});

test('the other fields of a sign-in form are left to the user too, and Continue resumes the task', async () => {
  const session = await run('type-login-email');
  const card = await session.waitForCard();
  assert.match(card, /Your turn/);

  await session.answer('Continue');
  await session.waitForEnd();
  assert.equal(await session.web.$eval('#email', el => el.value), '');
  await finish(session);
});

test('content that changes after the card is shown is not sent', async () => {
  const session = await run('send-button');
  await session.waitForCard();
  await session.web.$eval('#composer', el => {
    el.textContent = 'Something else entirely';
  });

  await session.answer('Confirm');
  const text = await session.waitForEnd();

  assert.deepEqual(await session.events(), []);
  assert.match(text, /page changed while waiting/);
  await finish(session);
});

test('a kind switched off in settings runs without asking, and is still checked afterwards', async () => {
  await extension.setConfirm({
    send: false,
    publish: true,
    submit: true,
    delete: true,
    purchase: true,
    permission: true,
  });
  try {
    const session = await run('send-button');
    const text = await session.waitForEnd();

    assert.deepEqual(await session.events(), [{ type: 'sent', text: 'Hello team\nSecond line' }]);
    assert.doesNotMatch(text, /Waiting for you/);
    assert.match(text, /Checked: the text now shows on the page/);
    await finish(session);
  } finally {
    await extension.setConfirm({
      send: true,
      publish: true,
      submit: true,
      delete: true,
      purchase: true,
      permission: true,
    });
  }
});

test('a form is filled in one go, and every question is asked at once', async () => {
  const session = await run('form-fill-once');
  const card = await session.waitForCard();

  // The known field is already in, before the user is asked anything
  assert.match(card, /2 questions/);
  assert.match(card, /What should the notes say\?/);
  assert.match(card, /Any company name\?/);
  assert.equal(await session.web.evaluate(() => document.querySelector('#name').value), 'Ada Lovelace');

  await session.panel.type('[role="alertdialog"] input', 'Two rooms');
  await session.answer('Fill these in');

  // The answers reach the model in one message; a blank one says to leave the field empty
  const submit = await session.waitForCard();
  assert.match(submit, /Confirm: Submit a form/);
  const asked = mock.run.requests.find(text => text.includes('What should the notes say? → Two rooms'));
  assert.ok(asked, 'the answers reached the model');
  assert.match(asked, /Any company name\? → \(left blank/);

  await session.answer('Confirm');
  await session.waitForEnd();
  assert.deepEqual(await session.events(), [{ type: 'quote', name: 'Ada Lovelace', notes: 'Two rooms' }]);
  await finish(session);
});

/**
 * Waits until the chat is idle on screen and in the database: the Stop button is the Send button again, no
 * "Working on the page" line is left, no card is up, and the thread is idle with nothing pending.
 */
async function waitSettled(session, title, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const screen = await session.panel.evaluate(() => ({
      stop: !!document.querySelector('button[aria-label="Stop"]'),
      send: !!document.querySelector('button[type="submit"][aria-label="Send"]'),
      working: document.body.innerText.includes('Working on the page'),
      card: !!document.querySelector('[role="alertdialog"]'),
    }));
    const thread = (await readThreads(session.panel)).find(item => item.title.includes(title));
    last = { ...screen, status: thread?.status, activity: thread?.activity, pending: thread?.pendingRequest ?? null };
    if (
      !screen.stop &&
      screen.send &&
      !screen.working &&
      !screen.card &&
      thread?.status === 'idle' &&
      !thread.activity &&
      !thread.pendingRequest
    ) {
      return thread;
    }
    await sleep(300);
  }
  throw new Error(`The chat did not settle: ${JSON.stringify(last)}`);
}

test('Cancel on a confirm card settles the chat: Send is back, nothing is working, and a new message runs', async () => {
  const session = await run('cancel-settles');
  const card = await session.waitForCard();
  assert.match(card, /Confirm: Submit a form/);

  await session.answer('Cancel');
  await session.waitForEnd();
  const thread = await waitSettled(session, 'cancel-settles');
  assert.match(await session.panelText(), /Cancelled: /);
  // It stays settled: nothing recorded late makes it look busy again
  await sleep(1500);
  await waitSettled(session, 'cancel-settles', 2000);
  assert.deepEqual(await session.events(), [], 'nothing was submitted');

  // The next message right after the cancel runs, in the same chat
  mock.start('after-cancel');
  await session.send('Run the scripted scenario after-cancel.');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !(mock.runs.get('after-cancel')?.requests.length > 0)) await sleep(200);
  assert.ok(
    mock.runs.get('after-cancel')?.requests.length > 0,
    `the new message ran. Panel shows: ${(await session.panelText()).slice(-400)}`,
  );
  const again = await waitSettled(session, 'cancel-settles', 30000);
  assert.equal(again.id, thread.id, 'the same chat ran it');
  await finish(session);
});

test('Stop while a question waits settles the chat, and Stop again changes nothing', async () => {
  const session = await run('question-stop');
  const card = await session.waitForCard();
  assert.match(card, /Which payment link should clients use\?/);

  await session.click('Stop');
  await waitSettled(session, 'question-stop');
  // A second Stop (the button is Send again, so straight to the background) is harmless
  await session.panel.evaluate(
    threadId => {
      const port = chrome.runtime.connect({ name: 'side-panel-connection' });
      port.postMessage({ type: 'thread_cancel', threadId });
      setTimeout(() => port.disconnect(), 300);
    },
    (await readThreads(session.panel)).find(item => item.title.includes('question-stop')).id,
  );
  await sleep(800);
  await waitSettled(session, 'question-stop', 2000);
  await finish(session);
});
