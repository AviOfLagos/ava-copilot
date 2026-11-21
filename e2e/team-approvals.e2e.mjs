/**
 * Approval modes, the budget ledger and tool requests (docs/growth-team.md, Part 9), in a real browser profile:
 * an agent's drafts land in the Inbox as a batch that one tap approves, a spending request shows its four
 * answers and is counted by the ledger only after the user's yes, and nothing is posted or sent.
 *
 * Run: pnpm build && node --test e2e/team-approvals.e2e.mjs
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension, openSession, readThreads, sleep } from './harness.mjs';
import { startMockLlm } from './mock-llm.mjs';

const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const draft = (title, text) => ({
  queue_for_approval: {
    intent: 'Leaving a draft',
    kind: 'post',
    title,
    text,
    where: 'x',
    why: "This week's experiment",
  },
});

const scenarios = {
  'queue-drafts': [
    () => [draft('Show the fix loop', 'A failing trace, the fix, and the eval that now passes.')],
    () => [draft('What we learned', 'Three things we learned building evals this week.')],
    () => [draft('Reply to a question', 'Yes: drift detection runs on every trace.')],
    () => [
      {
        request_spend: {
          intent: 'Asking for a paid critique',
          amount_usd: 30,
          buys: 'A paid critique of the landing page',
          tried_free: 'Asked two design communities, one reply',
          expected: 'Sign-up rate from 2% to 3%',
        },
      },
    ],
    // Past the budget: code refuses it, and nothing reaches the Inbox
    () => [
      {
        request_spend: {
          intent: 'Asking for ads',
          amount_usd: 500,
          buys: 'A month of ads',
          tried_free: 'Posted for a week for free',
          expected: 'More sign-ups',
        },
      },
    ],
    () => [
      {
        request_tool: {
          intent: 'A scheduler',
          need: 'Schedule posts for the week',
          tool: 'Buffer',
          rung: 'free_tier',
          tried: 'Nothing connected schedules posts and the site alone cannot queue them.',
          steps: '1. Open buffer.com 2. Sign up with the product email 3. Connect X',
        },
      },
    ],
    done,
  ],
};

let mock;
let extension;
let session;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
  session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 1600 });
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

const textOf = testId =>
  session.panel.evaluate(testId => document.querySelector(`[data-testid="${testId}"]`)?.innerText ?? '', testId);

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

async function openWorkspaces(name) {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await session.openAccountMenu();
  await until(() => clickByName('Workspaces'), 'Workspaces in the profile menu');
  await until(() => session.panel.evaluate(() => document.body.innerText.includes('Add workspace')), 'the list');
  if (!name) return;
  await until(
    () =>
      session.panel.evaluate(name => {
        const row = [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(name));
        row?.click();
        return Boolean(row);
      }, name),
    `the workspace ${name}`,
  );
  await session.panel.waitForSelector('[data-testid="product-ledger"]');
}

async function openInbox() {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await until(() => clickByName('Inbox'), 'Inbox in the menu');
  await until(() => session.panel.evaluate(() => document.body.innerText.includes('Approvals')), 'the Inbox');
}

/** Clicks a button inside the Inbox row whose title holds `title`. */
function clickInRow(title, button) {
  return session.panel.evaluate(
    (title, button) => {
      const row = [...document.querySelectorAll('li')].find(item => item.innerText.includes(title));
      const target = [...(row?.querySelectorAll('button') ?? [])].find(el => el.innerText.trim() === button);
      target?.click();
      return Boolean(target);
    },
    title,
    button,
  );
}

test('a product gets a budget, and the ledger shows nothing spent', async () => {
  await openWorkspaces();
  assert.ok(await clickByName('Add workspace'));
  await fillField('Name', 'Rocket Shop');
  await fillField('Words that mean', 'rocket shop');
  assert.ok(await clickByName('Add the product this workspace sells'));
  await session.panel.waitForSelector('[data-testid="product-fields"]');
  await fillField('Site', 'https://rocketshop.test');
  await fillField('Marketing budget (USD)', '100');
  assert.ok(await clickByName('Save'));
  await until(async () => (await extension.getStorage('products'))?.items?.['rocket-shop']?.budget, 'the budget');

  await openWorkspaces('Rocket Shop');
  assert.match(
    await until(() => textOf('ledger-budget'), 'the budget line'),
    /\$0\.00 of \$100\.00 spent, \$100\.00 left/,
  );
  assert.match(await textOf('ledger-beta'), /Beta rule: not set/);
});

test('drafts land in the Inbox as a batch, and code refuses a request past the budget', async () => {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await until(() => clickByName('New chat'), 'New chat');
  await session.panel.waitForSelector('textarea', { timeout: 10000 });
  mock.start('queue-drafts');
  const text = 'Rocket Shop drafts for the week. Run the scripted scenario queue-drafts.';
  await session.send(text);
  await until(
    async () => (await readThreads(session.panel)).find(item => item.title?.startsWith(text.slice(0, 20))),
    'the chat',
  );
  await session.waitForEnd(40000);

  // What the agent was told after its steps, over the whole run: queued, refused, never "posted"
  const told = mock.runs.get('queue-drafts').requests.join('\n');
  assert.match(told, /Queued in the batch the user approves\. Nothing has gone out/);
  assert.match(told, /Sent to the user as a request in the Inbox/);
  assert.match(told, /Refused by a rule in code: Only \$100\.00 of the \$100\.00 budget is left/);

  const items = await table('teamItems');
  assert.deepEqual(items.map(item => `${item.action}:${item.mode}:${item.status}`).sort(), [
    'new_account:always_ask:queued',
    'post:batch:queued',
    'post:batch:queued',
    'post:batch:queued',
    'spend:always_ask:queued',
  ]);
  assert.equal((await table('teamLedger')).length, 0, 'nothing is counted before the user says yes');
});

test('one tap approves the batch, and the approved drafts are held, not posted', async () => {
  await openInbox();
  await until(
    () => session.panel.evaluate(() => document.body.innerText.includes('Approve all 3 drafts from Ava')),
    'the batch row',
  );
  const before = await session.panelText();
  assert.match(before, /Ava · Post: Show the fix loop/);
  assert.match(before, /Ava · Spending request: A paid critique of the landing page/);
  assert.match(before, /Ava · New account: Open a free Buffer account/);

  assert.ok(await clickInRow('Approve all 3 drafts from Ava', 'Approve'));
  await until(
    async () => (await table('teamItems')).filter(item => item.status === 'held').length === 3,
    'three held drafts',
  );
  const posts = (await table('teamItems')).filter(item => item.action === 'post');
  assert.ok(posts.every(item => /Nothing has gone out/.test(item.note)));
  // The batch row and the three draft rows are settled; the two requests still wait
  await until(
    async () => (await table('inbox')).filter(item => item.kind === 'approval' && item.status !== 'done').length === 2,
    'two open approvals',
  );
});

test('the spending request shows its four answers, and the ledger counts it only after the yes', async () => {
  await until(
    () =>
      session.panel.evaluate(() => {
        const row = [...document.querySelectorAll('li')].find(item => item.innerText.includes('Spending request'));
        row?.querySelector('button')?.click();
        return Boolean(row);
      }),
    'the spending request row',
  );
  await until(() => session.panel.evaluate(() => document.body.innerText.includes('Amount: $30.00')), 'the detail');
  const detail = await session.panelText();
  assert.match(detail, /What it buys: A paid critique of the landing page/);
  assert.match(detail, /Tried for free first: Asked two design communities, one reply/);
  assert.match(detail, /Result expected: Sign-up rate from 2% to 3%/);
  // Spending is never remembered: there is no "Allow every time" on it
  assert.doesNotMatch(detail, /Allow every time/);

  assert.ok(await clickByName('Approve'));
  await until(async () => (await table('teamLedger')).length === 1, 'the ledger line');
  assert.deepEqual(
    (await table('teamLedger')).map(entry => [entry.kind, entry.amount]),
    [['spend', 30]],
  );
  assert.deepEqual((await extension.getStorage('permission-rules'))?.rules ?? [], []);

  await openWorkspaces('Rocket Shop');
  assert.match(
    await until(() => textOf('ledger-budget'), 'the budget line'),
    /\$30\.00 of \$100\.00 spent, \$70\.00 left/,
  );
  assert.match(await textOf('ledger-waiting'), /1 waiting for your approval, 3 approved and held/);
});
