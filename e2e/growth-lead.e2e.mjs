/**
 * The Growth Lead (docs/growth-team.md, Part 8), in a real browser profile: the team setup shows a "Growth team"
 * group, a growth agent needs a workspace with a product, and a sorted bug becomes a "[P0]" issue waiting in the
 * Inbox while a summary that holds a customer's email is sent back by code. Nothing is filed.
 *
 * Run: pnpm build && node --test e2e/growth-lead.e2e.mjs
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension, openSession, readThreads, sleep } from './harness.mjs';
import { startMockLlm } from './mock-llm.mjs';

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const sort = fields => ({ sort_feedback: { intent: 'Sorting feedback', ...fields } });

const scenarios = {
  'sort-feedback': [
    () => [
      sort({
        feedback_id: 'fb-1',
        sort: 'bug',
        title: 'Magic link sign-in never arrives',
        summary: 'A customer cannot sign in: the magic link email never arrives.',
        cannot_sign_in: true,
      }),
    ],
    () => [
      sort({
        feedback_id: 'fb-2',
        sort: 'bug',
        title: 'Checkout fails',
        summary: 'ada@acme.test says the checkout page fails.',
        main_flow_broken: true,
      }),
    ],
    () => [sort({ feedback_id: 'fb-1', sort: 'bug', title: 'Again', summary: 'Sorted twice.', cannot_sign_in: true })],
    done,
  ],
};

let mock;
let extension;
let session;

// E2E_SNAPS=<folder>: saves the panel at each step, for the short recording of the feature
let snapCount = 0;
async function snap(name) {
  const folder = process.env.E2E_SNAPS;
  if (!folder) return;
  await sleep(400);
  snapCount += 1;
  await session.panel.screenshot({ path: `${folder}/${String(snapCount).padStart(2, '0')}-${name}.png` });
}

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
  throw new Error(`Timed out waiting for ${what}. Panel: ${(await session.panelText()).slice(0, 800)}`);
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

function fillField(label, value) {
  return session.panel.evaluate(
    (label, value) => {
      document.querySelectorAll('details').forEach(group => (group.open = true));
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

const table = name =>
  session.panel.evaluate(
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

async function openMenuItem(label, ready) {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await until(() => clickByName(label), `${label} in the menu`);
  await until(() => session.panel.evaluate(ready => document.body.innerText.includes(ready), ready), label);
}

async function openSetup() {
  await openMenuItem('Agents', 'Set up my team');
  await session.panel.evaluate(() => document.querySelector('[data-team-setup]').click());
  await session.panel.waitForSelector('[data-growth-team] [data-team-template="growth_lead"]', { timeout: 10000 });
}

test('a workspace gets a product', async () => {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await session.openAccountMenu();
  await until(() => clickByName('Workspaces'), 'Workspaces in the profile menu');
  await until(() => session.panel.evaluate(() => document.body.innerText.includes('Add workspace')), 'the list');
  assert.ok(await clickByName('Add workspace'));
  await fillField('Name', 'Rocket Shop');
  await fillField('Words that mean', 'rocket shop');
  assert.ok(await clickByName('Add the product this workspace sells'));
  await session.panel.waitForSelector('[data-testid="product-fields"]');
  await fillField('Site', 'https://rocketshop.test');
  assert.ok(await clickByName('Save'));
  await until(async () => (await extension.getStorage('products'))?.items?.['rocket-shop'], 'the product');
});

test('the team setup has a Growth team group, and a growth agent needs a workspace with a product', async () => {
  await openSetup();
  const group = await session.panel.evaluate(() => document.querySelector('[data-growth-team]').textContent);
  assert.match(group, /Growth team/);
  assert.match(group, /Growth Lead/);
  assert.match(group, /nothing is posted, sent, granted or spent without your click/);
  await session.panel.evaluate(() => document.querySelector('[data-team-template="growth_lead"]').click());
  await snap('growth-group');

  // No workspace picked: refused, and no agent is made
  await session.panel.evaluate(() => document.querySelector('[data-team-create]').click());
  await until(
    () => session.panel.evaluate(() => document.body.innerText.includes('The growth team works for one product')),
    'the refusal',
  );
  assert.equal((await table('agents')).filter(agent => agent.template === 'growth_lead').length, 0);

  // The product's workspace: a draft of the Growth Lead, with the growth personality, in the browser
  await session.panel.evaluate(() => {
    const select = document.querySelector('[data-team-setup-form] select, form select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'rocket-shop');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await session.panel.evaluate(() => document.querySelector('[data-team-create]').click());
  const lead = await until(
    async () => (await table('agents')).find(agent => agent.template === 'growth_lead') ?? null,
    'the Growth Lead draft',
  );
  assert.equal(lead.status, 'draft');
  assert.equal(lead.workspaceId, 'rocket-shop');
  assert.equal(lead.executor, 'browser');
  assert.equal(lead.personalityId, 'growth');
  await snap('lead-draft');
});

test('a sorted bug waits in the Inbox as a P0 issue, and a customer email is sent back by code', async () => {
  await openMenuItem('New chat', '');
  await session.panel.waitForSelector('textarea', { timeout: 10000 });
  mock.start('sort-feedback');
  const text = 'Rocket shop feedback. Run the scripted scenario sort-feedback.';
  await session.send(text);
  await until(
    async () => (await readThreads(session.panel)).find(item => item.title?.startsWith(text.slice(0, 20))),
    'the chat',
  );
  await session.waitForEnd(40000);

  const told = mock.runs.get('sort-feedback').requests.join('\n');
  assert.match(told, /Sorted as bug, P0 \(cannot sign in\)/);
  assert.match(told, /Refused by a rule in code: The summary holds an email address/);
  assert.match(told, /Feedback fb-1 was sorted before/);

  const items = await table('teamItems');
  assert.deepEqual(
    items.map(item => `${item.action}:${item.title}:${item.status}`),
    ['customer_issue:[P0] Magic link sign-in never arrives:queued'],
  );
  assert.equal((await table('teamFeedback')).length, 1, 'the refused one is not recorded as sorted');

  await openMenuItem('Inbox', 'Approvals');
  await until(
    () => session.panel.evaluate(() => document.body.innerText.includes('[P0] Magic link sign-in never arrives')),
    'the issue in the Inbox',
  );
  await snap('inbox-p0');
  // The row opens to the whole issue, priority first, ready for the user's click
  await session.panel.evaluate(() =>
    [...document.querySelectorAll('button[aria-label]')]
      .find(button => button.getAttribute('aria-label').includes('[P0] Magic link'))
      .click(),
  );
  await until(
    () => session.panel.evaluate(() => document.body.innerText.includes('Label: from-customer')),
    'the issue opened',
  );
  await snap('issue-open');
});
