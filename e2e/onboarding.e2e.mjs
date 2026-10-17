import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { startMockLlm, startMockOllama } from './mock-llm.mjs';
import { launchExtension, openSession, sleep } from './harness.mjs';

/**
 * End-to-end test of the first-run setup: it covers the panel on first open, names the assistant (the
 * name then shows in the panel), says when the wake word cannot follow the name, skips with Skip or Esc,
 * and never shows again. Each test has its own browser profile, so each sees a first run.
 * A fresh install has no model: the model step only goes on once one works (a local server found and added, or a
 * key checked), and skipping leaves "Finish setup" pointing back at it. E2E_SHOTS=<dir> saves a 400 px screenshot
 * of each state.
 */

const DIALOG = '[role="dialog"][aria-label="Set up your assistant"]';

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];

let mock;
before(async () => {
  mock = await startMockLlm({ 'first-chat': [done], 'key-chat': [done] });
});
after(async () => {
  await mock?.close();
});

/** Whether nothing listens on a port (a real Ollama would answer instead of the stand-in). */
const portFree = port =>
  new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(true));
  });

async function shot(panel, name) {
  if (!process.env.E2E_SHOTS) return;
  await panel.bringToFront();
  await sleep(250);
  await panel.screenshot({ path: path.join(process.env.E2E_SHOTS, `onboarding-${name}.png`) });
}

async function firstRun({ model = true } = {}) {
  const extension = await launchExtension(mock, { onboarding: true, model });
  const panel = await extension.browser.newPage();
  await panel.setViewport({ width: 400, height: 760 });
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.bringToFront();
  const text = async () => (await panel.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  const waitForText = async (pattern, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (pattern.test(await text())) return;
      await sleep(150);
    }
    throw new Error(`Never showed ${pattern}. Panel shows: ${(await text()).slice(0, 500)}`);
  };
  const typeName = value =>
    panel.evaluate(value => {
      const input = document.querySelector('#onboard-name');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  const clickInDialog = label =>
    panel.evaluate(
      (selector, label) => {
        const button = [...document.querySelector(selector).querySelectorAll('button')].find(
          b => b.innerText.replace(/[↵\s]+$/, '').trim() === label,
        );
        if (!button) throw new Error(`No button "${label}"`);
        button.click();
      },
      DIALOG,
      label,
    );
  /** Sets a field by its id as typing would (inputs) or choosing (selects). */
  const setField = (id, value) =>
    panel.evaluate(
      (id, value) => {
        const field = document.getElementById(id);
        const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
        field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      },
      id,
      value,
    );
  const nextDisabled = () =>
    panel.evaluate(
      selector =>
        [...document.querySelector(selector).querySelectorAll('button')].find(b =>
          /^(Next|Done)/.test(b.innerText.trim()),
        )?.disabled,
      DIALOG,
    );
  const clickButton = label =>
    panel.evaluate(label => {
      const button = [...document.querySelectorAll('button')].find(
        b => b.innerText.replace(/[↵\s]+$/, '').trim() === label,
      );
      if (!button) throw new Error(`No button "${label}"`);
      button.click();
    }, label);
  /** From the name step to the model step, keeping Ava. */
  const toModelStep = async () => {
    await panel.waitForSelector(DIALOG, { timeout: 10000 });
    await clickInDialog('Next');
    await waitForText(/Step 2 of 3/i);
    await panel.waitForSelector('[data-testid="model-setup"]');
  };
  return {
    extension,
    panel,
    text,
    waitForText,
    typeName,
    clickInDialog,
    setField,
    nextDisabled,
    clickButton,
    toModelStep,
  };
}

test('first open shows the setup; naming it "Nova" shows Nova in the panel, and it does not come back', async () => {
  const run = await firstRun();
  const { extension, panel } = run;
  try {
    await panel.waitForSelector(DIALOG, { timeout: 10000 });
    await run.waitForText(/Step 1 of 3/i);
    await run.waitForText(/Name your assistant/);
    assert.equal(await panel.$eval('#onboard-name', input => input.value), 'Ava', 'prefilled with Ava');
    assert.equal(
      await panel.evaluate(() => document.activeElement?.id),
      'onboard-name',
      'the name field has the focus',
    );

    // Not a valid name: an error, and it stays on the first step
    await run.typeName('R2D2');
    await panel.keyboard.press('Enter');
    await run.waitForText(/Use letters, spaces, hyphens and apostrophes only/);
    assert.match(await run.text(), /Step 1 of 3/i);

    // A name the on-device model does not know keeps "Hey Ava", and says so
    await run.typeName('Zorblax');
    await run.waitForText(/Wake word stays “Hey Ava”: “Zorblax” isn’t in the on-device model’s vocabulary/);

    await run.typeName('Nova');
    await sleep(300);
    assert.equal(await panel.$('[data-testid="wake-note"]'), null, 'Nova is in the vocabulary');
    await panel.keyboard.press('Enter');
    await run.waitForText(/Step 2 of 3/i);
    await run.waitForText(/Add a model/);
    assert.equal((await extension.getStorage('general-settings'))?.assistantName, 'Nova', 'the name is saved on Next');
    // A model is already set up here: the step says so and lets it go on
    await run.waitForText(/Ready\. Using scripted from mock/);
    assert.equal(await run.nextDisabled(), false);

    await run.clickInDialog('Next');
    await run.waitForText(/Step 3 of 3/i);
    await run.waitForText(/Say “Hey Nova” to start talking/);
    assert.ok(await panel.$(`${DIALOG} [role="switch"][aria-label="Listen for “Hey Nova”"]`), 'the wake switch');
    assert.equal((await extension.getStorage('meeting-settings'))?.wakeWord ?? false, false, 'the wake word stays off');

    await run.clickInDialog('Done');
    await panel.waitForFunction(selector => !document.querySelector(selector), { polling: 200 }, DIALOG);
    assert.ok((await extension.getStorage('onboarding'))?.completedAt > 0);

    // The name is used in the panel
    await panel.waitForSelector('[data-testid="assistant-name"]');
    assert.equal(await panel.$eval('[data-testid="assistant-name"]', el => el.textContent.trim()), 'Nova');
    assert.ok(await panel.$('[aria-label="Talk to Nova"]'), 'the talk button names Nova');

    // It does not come back
    await panel.reload();
    await panel.waitForSelector('textarea');
    await sleep(800);
    assert.equal(await panel.$(DIALOG), null);
  } finally {
    await extension.close();
  }
});

test('Skip and Esc end the setup at once, keep Ava, and it does not show again', async () => {
  const run = await firstRun();
  const { extension, panel } = run;
  try {
    await panel.waitForSelector(DIALOG, { timeout: 10000 });
    await run.typeName('Juno');
    await run.clickInDialog('Skip');
    await panel.waitForFunction(selector => !document.querySelector(selector), { polling: 200 }, DIALOG);
    assert.ok((await extension.getStorage('onboarding'))?.completedAt > 0);
    assert.equal((await extension.getStorage('general-settings'))?.assistantName ?? 'Ava', 'Ava', 'Skip saves no name');
    assert.equal(await panel.$eval('[data-testid="assistant-name"]', el => el.textContent.trim()), 'Ava');

    // Esc, from a later step, on a setup shown again
    await extension.removeStorage(['onboarding']);
    await panel.reload();
    await panel.waitForSelector(DIALOG, { timeout: 10000 });
    await panel.keyboard.press('Enter');
    await run.waitForText(/Step 2 of 3/i);
    await panel.keyboard.press('Escape');
    await panel.waitForFunction(selector => !document.querySelector(selector), { polling: 200 }, DIALOG);
    await panel.reload();
    await panel.waitForSelector('textarea');
    await sleep(800);
    assert.equal(await panel.$(DIALOG), null);
  } finally {
    await extension.close();
  }
});

test('a fresh install: the model step waits for a local server, adds it in one click, and the panel then works', async t => {
  if (!(await portFree(11434))) {
    t.skip('Something already listens on 11434 (a real Ollama?)');
    return;
  }
  const run = await firstRun({ model: false });
  const { extension, panel } = run;
  let ollama;
  try {
    await run.toModelStep();
    // Nothing is set up: Next waits, and Enter does not get past it either
    assert.equal(await run.nextDisabled(), true, 'Next is blocked without a model');
    await run.waitForText(/Connect a model to go on, or Skip for now/);
    await run.waitForText(/No local model server is running yet/);
    await run.waitForText(/ollama pull \S+/);
    await panel.keyboard.press('Enter');
    await sleep(300);
    assert.match(await run.text(), /Step 2 of 3/i);
    await run.waitForText(/Watching for it/);
    await shot(panel, '1-local-none');

    // Ollama starts: the step notices it by itself
    ollama = await startMockOllama(mock);
    await run.waitForText(/Ollama is running on this computer with 2 models/, 12000);
    await shot(panel, '2-local-found');
    await run.clickButton('Use Ollama');
    await run.waitForText(/Ollama is connected/, 20000);
    await run.waitForText(/Ready\. Using qwen3:4b from Ollama/, 20000);
    await shot(panel, '3-local-ready');
    assert.equal(await panel.$eval('#onboard-local-ollama', select => select.value), 'qwen3:4b');
    assert.deepEqual((await extension.getStorage('agent-models'))?.agents?.navigator, {
      provider: 'ollama',
      modelName: 'qwen3:4b',
    });
    assert.equal(await run.nextDisabled(), false, 'Next goes on once a model works');

    await run.clickInDialog('Next');
    await run.waitForText(/Step 3 of 3/i);
    await run.clickInDialog('Done');
    await panel.waitForFunction(selector => !document.querySelector(selector), { polling: 200 }, DIALOG);
    await panel.waitForSelector('textarea', { timeout: 10000 });
    assert.equal(await panel.$('[data-testid="onboard-resume"]'), null, 'nothing is owed');

    // A chat runs on it
    mock.start('first-chat');
    const session = await openSession(extension, mock);
    await session.send('Run the scripted scenario first-chat.');
    await session.waitForEnd();
    assert.ok(mock.runs.get('first-chat').navigatorCalls.length > 0, 'the navigator was asked through Ollama');
    assert.deepEqual(mock.runs.get('first-chat').errors, []);
    await session.close();
  } finally {
    await ollama?.close();
    await extension.close();
  }
});

test('an API key is checked before it is kept: a refused key says why, a working one makes the panel ready', async () => {
  const run = await firstRun({ model: false });
  const { extension, panel } = run;
  try {
    await run.toModelStep();
    await run.clickButton('API key');
    await panel.waitForSelector('[data-testid="key-choice"]');
    await run.setField('onboard-key-provider', 'custom_openai');
    await panel.waitForSelector('#onboard-key-url');
    await run.setField('onboard-key-url', mock.keyedBaseUrl);

    // No key yet
    await run.clickButton('Check and connect');
    await run.waitForText(/Paste the API key first/);

    await run.setField('onboard-key', 'sk-bad-0000');
    await run.clickButton('Check and connect');
    await run.waitForText(/The provider refused this key/, 20000);
    await shot(panel, '4-key-refused');
    assert.equal(
      Object.keys((await extension.getStorage('llm-api-keys'))?.providers ?? {}).length,
      0,
      'a refused key is not saved',
    );
    assert.equal(await run.nextDisabled(), true);

    await run.setField('onboard-key', 'sk-good-1234');
    await run.clickButton('Check and connect');
    await run.waitForText(/The key works/, 20000);
    await run.waitForText(/Ready\. Using scripted from/, 20000);
    await shot(panel, '5-key-ready');
    assert.equal(await panel.$eval('#onboard-key', input => input.value), '', 'the typed key is cleared');
    const saved = (await extension.getStorage('llm-api-keys'))?.providers ?? {};
    assert.ok(saved.custom_openai_1, 'saved as a custom provider');
    assert.ok(!JSON.stringify(saved).includes('sk-good-1234'), 'the key is in the vault, not in plain storage');

    await run.clickInDialog('Next');
    await run.clickInDialog('Done');
    await panel.waitForFunction(selector => !document.querySelector(selector), { polling: 200 }, DIALOG);
    await panel.waitForSelector('textarea', { timeout: 10000 });

    mock.start('key-chat');
    const session = await openSession(extension, mock);
    await session.send('Run the scripted scenario key-chat.');
    await session.waitForEnd();
    assert.ok(mock.runs.get('key-chat').navigatorCalls.length > 0);
    await session.close();
  } finally {
    await extension.close();
  }
});

test('skipping without a model keeps it owed: the welcome screen and Finish setup lead back to the model step', async () => {
  const run = await firstRun({ model: false });
  const { extension, panel } = run;
  try {
    await panel.waitForSelector(DIALOG, { timeout: 10000 });
    await run.clickInDialog('Skip');
    await panel.waitForFunction(selector => !document.querySelector(selector), { polling: 200 }, DIALOG);
    assert.ok((await extension.getStorage('onboarding'))?.completedAt > 0);

    // Not ready: the welcome screen, whose button opens the model step alone
    await run.waitForText(/Connect one model to start/);
    assert.equal(await panel.$('textarea'), null, 'no composer without a model');
    assert.equal(await panel.$('[data-testid="onboard-resume"]'), null, 'the welcome screen has its own button');
    await shot(panel, '6-welcome');
    await run.clickButton('Connect a model');
    await panel.waitForSelector(`${DIALOG} [data-testid="model-setup"]`, { timeout: 5000 });
    assert.doesNotMatch(await run.text(), /Step \d of 3/i);
    assert.equal(await run.nextDisabled(), true, 'Done waits for a model too');
    await shot(panel, '7-reopened');

    // Off to Models & usage: the pill brings the model step back
    await run.clickButton('More providers and settings in Models & usage');
    await panel.waitForSelector('[data-testid="onboard-resume"]', { timeout: 5000 });
    await shot(panel, '8-pill');
    await run.clickButton('Finish setup');
    await panel.waitForSelector(`${DIALOG} [data-testid="model-setup"]`, { timeout: 5000 });
    await panel.keyboard.press('Escape');
    await panel.waitForFunction(selector => !document.querySelector(selector), { polling: 200 }, DIALOG);

    // Still owed after a reload: the full setup does not come back, the welcome screen does
    await panel.reload();
    await run.waitForText(/Connect one model to start/);
    await sleep(500);
    assert.equal(await panel.$(DIALOG), null);
  } finally {
    await extension.close();
  }
});
