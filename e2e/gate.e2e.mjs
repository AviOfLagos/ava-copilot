import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

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
