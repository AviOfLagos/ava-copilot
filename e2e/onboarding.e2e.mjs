import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, sleep } from './harness.mjs';

/**
 * End-to-end test of the first-run setup: it covers the panel on first open, names the assistant (the
 * name then shows in the panel), says when the wake word cannot follow the name, skips with Skip or Esc,
 * and never shows again. Each test has its own browser profile, so each sees a first run.
 */

const DIALOG = '[role="dialog"][aria-label="Set up your assistant"]';

let mock;
before(async () => {
  mock = await startMockLlm({});
});
after(async () => {
  await mock?.close();
});

async function firstRun() {
  const extension = await launchExtension(mock, { onboarding: true });
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
  return { extension, panel, text, waitForText, typeName, clickInDialog };
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
