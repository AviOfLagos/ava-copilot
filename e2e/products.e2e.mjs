import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, readThreads, sleep } from './harness.mjs';

/**
 * End-to-end tests of the product profile (#69): a workspace gets a product in the workspace screen, an agent in
 * that workspace is told its facts and that the rest is "not set", Ava changes it only after the user confirms,
 * and the owner's build seeds Suture.
 */

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];

const scenarios = {
  'product-facts': [done],
  'change-price': [() => [{ update_product_profile: { intent: 'The price went up', pricing: '$12 a month' } }], done],
  'refuse-price': [() => [{ update_product_profile: { intent: 'Make it free', pricing: 'Free forever' } }], done],
};

let mock;
let extension;
let session;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
  session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 1400 });
});

after(async () => {
  await session?.close().catch(() => {});
  await extension?.close();
  await mock?.close();
});

async function until(check, what, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}. Panel: ${(await session.panelText()).slice(0, 600)}`);
}

function clickByName(label) {
  return session.panel.evaluate(label => {
    const element = [...document.querySelectorAll('button, [role="menuitem"]')].find(
      el => el.innerText?.trim() === label || el.getAttribute('aria-label') === label,
    );
    element?.click();
    return Boolean(element);
  }, label);
}

/** Types into the editor's field whose label starts with `label`. */
function fillField(label, value) {
  return session.panel.evaluate(
    (label, value) => {
      const field = [...document.querySelectorAll('label')]
        .find(el => el.innerText.trim().startsWith(label))
        ?.querySelector('input, textarea');
      if (!field) throw new Error(`No field "${label}"`);
      const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    },
    label,
    value,
  );
}

const fieldValue = label =>
  session.panel.evaluate(
    label =>
      [...document.querySelectorAll('label')]
        .find(el => el.innerText.trim().startsWith(label))
        ?.querySelector('input, textarea')?.value,
    label,
  );

const missingLine = () =>
  session.panel.evaluate(() => document.querySelector('[data-testid="product-missing"]')?.innerText ?? '');

async function openWorkspaces() {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await session.openAccountMenu();
  await until(() => clickByName('Workspaces'), 'Workspaces in the profile menu');
  await until(() => session.panel.evaluate(() => document.body.innerText.includes('Add workspace')), 'the list');
}

const openWorkspace = name =>
  session.panel.evaluate(name => {
    const row = [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(name));
    row?.click();
    return Boolean(row);
  }, name);

const products = async () => (await extension.getStorage('products'))?.items ?? {};

async function newChatSaying(text, scenario) {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await until(() => clickByName('New chat'), 'New chat');
  await session.panel.waitForSelector('textarea', { timeout: 10000 });
  mock.start(scenario);
  await session.send(text);
  return until(
    async () => (await readThreads(session.panel)).find(item => item.title?.startsWith(text.slice(0, 20))),
    `the chat "${text}"`,
  );
}

test('a workspace gets a product, and what is left empty reads "Not set"', async () => {
  await openWorkspaces();
  assert.ok(await clickByName('Add workspace'));
  await fillField('Name', 'Rocket Shop');
  await fillField('Words that mean', 'rocket shop');
  assert.ok(await clickByName('Add the product this workspace sells'));
  await session.panel.waitForSelector('[data-testid="product-fields"]');

  // Before anything is typed, every gap is named
  assert.match(
    await missingLine(),
    /Not set yet: who it is for, pricing, outreach email, postal address, beta rule, social accounts, north star, where to tell you/,
  );
  await fillField('Who it is for', 'Hobby rocketeers\nSchool science clubs');
  await fillField('Pricing', '$9 a month');
  await until(async () => !/pricing/.test(await missingLine()), 'the pricing gap to close');
  assert.match(await missingLine(), /^Not set yet: outreach email, postal address, beta rule, social accounts/);

  // Numbers and channel rows can be typed a key at a time: "12.5" is not cut to 125, and a row keeps its id
  await session.panel.evaluate(() => document.querySelectorAll('details').forEach(group => (group.open = true)));
  for (const [label, keys] of [
    ['Marketing budget', '12.5'],
    ['Slack channels', '#rocket-alerts C0123456789\n#rocket-sales'],
  ]) {
    await session.panel.evaluate(label => {
      [...document.querySelectorAll('label')]
        .find(el => el.innerText.trim().startsWith(label))
        .querySelector('input, textarea')
        .focus();
    }, label);
    for (const key of keys) await session.panel.keyboard.press(key === '\n' ? 'Enter' : key);
  }
  assert.equal(await fieldValue('Marketing budget'), '12.5');

  assert.ok(await clickByName('Save'));
  const saved = await until(async () => (await products())['rocket-shop'], 'the product to be saved');
  assert.deepEqual(saved.budget, { totalUsd: 12.5, spentUsd: 0 });
  assert.deepEqual(saved.slackChannels, [
    { name: '#rocket-alerts', id: 'C0123456789' },
    { name: '#rocket-sales', id: '' },
  ]);
  assert.equal(saved.stage, null, 'no stage was picked, so none is stored');
  assert.equal(saved.name, 'Rocket Shop');
  assert.deepEqual(saved.audience, ['Hobby rocketeers', 'School science clubs']);
  assert.equal(saved.pricing, '$9 a month');
  // What was never typed is stored as nothing, not as a guess
  assert.equal(saved.email, null);
  assert.equal(saved.betaRule, null);
  assert.equal(saved.postalAddress, '');
  assert.deepEqual(saved.social, {});

  // It is still there when the workspace is opened again
  assert.ok(await until(() => openWorkspace('Rocket Shop'), 'the workspace row'));
  await session.panel.waitForSelector('[data-testid="product-fields"]');
  assert.equal(await until(() => fieldValue('Pricing'), 'the saved pricing'), '$9 a month');
  assert.ok(await clickByName('Cancel'));
});

test('an agent in that workspace is told the audience and the pricing, and that the rest is not set', async () => {
  const thread = await newChatSaying(
    `Tell the Rocket Shop team our price. ${'Run the scripted scenario product-facts.'}`,
    'product-facts',
  );
  await session.waitForEnd(30000);
  const placed = (await readThreads(session.panel)).find(item => item.id === thread.id);
  assert.equal(placed.workspaceId, 'rocket-shop');

  const state = mock.runs.get('product-facts').navigatorCalls[0];
  assert.match(state, /\[Product: Rocket Shop\]/);
  assert.match(state, /Who it is for \(most valuable first\): Hobby rocketeers; School science clubs/);
  assert.match(state, /Pricing: \$9 a month/);
  assert.match(state, /Outreach email comes from: not set/);
  assert.match(state, /Beta rule: not set/);
  assert.match(state, /say you do not know it/);
});

test('Ava changes the profile only after the user confirms, and a refusal changes nothing', async () => {
  await newChatSaying('Rocket Shop price change. Run the scripted scenario change-price.', 'change-price');
  const card = await session.waitForCard();
  assert.match(card, /Product › Rocket Shop/);
  assert.match(card, /\$12 a month/);
  assert.match(card, /now: \$9 a month/);
  assert.equal((await products())['rocket-shop'].pricing, '$9 a month', 'nothing is saved while the card waits');
  await session.answer('Confirm');
  await until(async () => (await products())['rocket-shop'].pricing === '$12 a month', 'the confirmed change');
  await session.waitForEnd(30000);

  await newChatSaying('Rocket Shop goes free. Run the scripted scenario refuse-price.', 'refuse-price');
  assert.match(await session.waitForCard(), /Free forever/);
  await session.answer('Cancel');
  await session.waitForEnd(30000);
  assert.equal((await products())['rocket-shop'].pricing, '$12 a month');
});

test("the owner's build seeds Suture, with what he has not said yet shown as not set", async t => {
  const suture = (await products()).suture;
  if (!suture) {
    // A public build (no VITE_SEED_PROFILE=avi) must not carry it at all
    assert.equal(
      (await extension.getStorage('workspaces')).items.some(item => item.id === 'suture'),
      false,
    );
    t.skip('not the owner build: nothing of the owner is seeded');
    return;
  }
  assert.equal(suture.repo, 'AviOfLagos/suture');
  assert.deepEqual(suture.slackChannels, [{ name: '#suture-notifications', id: 'C0CKJC0CT4M' }]);
  assert.equal(suture.email, null);
  assert.equal(suture.betaRule, null);

  await openWorkspaces();
  assert.ok(await until(() => openWorkspace('Suture'), 'the Suture workspace'));
  await session.panel.waitForSelector('[data-testid="product-fields"]');
  assert.match(
    await until(missingLine, 'the not-set line'),
    /Not set yet: outreach email, postal address, beta rule, social accounts, north star, where to tell you/,
  );
  // The groups below the first are folded: open them all to read their fields
  await session.panel.evaluate(() => document.querySelectorAll('details').forEach(group => (group.open = true)));
  assert.equal(await fieldValue('Slack channels'), '#suture-notifications C0CKJC0CT4M');
  assert.equal(await fieldValue('Outreach email comes from'), '');
  assert.ok(await clickByName('Cancel'));
});
