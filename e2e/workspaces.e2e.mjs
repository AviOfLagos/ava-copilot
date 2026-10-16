import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, readThreads, sleep } from './harness.mjs';

/**
 * End-to-end tests of workspaces (Profile menu › Workspaces): add one with its words and accounts, rename it (its
 * id and chats stay), refuse a second workspace of the same name (routing could not tell them apart), make it the
 * default, and see where new chats go: the one their words name, else the default, never a deleted one.
 */

const done = () => [{ done: { text: 'Done.', success: true } }];
const scenarios = { 'ws-a': [done], 'ws-b': [done], 'ws-c': [done], 'ws-d': [done] };

let mock;
let extension;
let session;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
  session = await openSession(extension, mock);
  await session.panel.setViewport({ width: 400, height: 1000 });
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

async function openWorkspaces() {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await session.openAccountMenu();
  await until(() => clickByName('Workspaces'), 'Workspaces in the profile menu');
  await until(() => session.panel.evaluate(() => document.body.innerText.includes('Add workspace')), 'the list');
}

const stored = () => extension.getStorage('workspaces');

async function newChatSaying(text, scenario) {
  await session.panel.bringToFront();
  await clickByName('Menu');
  await sleep(300);
  await until(() => clickByName('New chat'), 'New chat');
  await session.panel.waitForSelector('textarea', { timeout: 10000 });
  mock.start(scenario);
  await session.send(text);
  const thread = await until(
    async () => (await readThreads(session.panel)).find(item => item.title?.startsWith(text.slice(0, 20))),
    `the chat "${text}"`,
  );
  await session.waitForEnd(30000).catch(() => {});
  return (await readThreads(session.panel)).find(item => item.id === thread.id);
}

test('a workspace is added with what it is, its words and its accounts', async () => {
  await openWorkspaces();
  assert.ok(await clickByName('Add workspace'));
  await fillField('Name', 'Acme Labs');
  await fillField('What it is', 'A client building rockets.');
  await fillField('Words that mean', 'Roadrunner, rocket sled ');
  await session.panel.evaluate(() => {
    const field = [...document.querySelectorAll('label')]
      .find(el => el.innerText.trim().startsWith('Google'))
      .querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'ceo@acme.io');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.ok(await clickByName('Save'));
  const acme = await until(async () => (await stored()).items.find(item => item.name === 'Acme Labs'), 'the save');
  assert.equal(acme.id, 'acme-labs');
  assert.deepEqual(acme.keywords, ['roadrunner', 'rocket sled']);
  assert.equal(acme.accounts.google, 'ceo@acme.io');
  assert.match(await session.panelText(), /Acme Labs A client building rockets\. · 1 accounts/);
});

test('renaming keeps its id; a second workspace with a name already used is refused', async () => {
  await session.panel.evaluate(() =>
    [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith('Acme Labs'))?.click(),
  );
  await fillField('Name', 'Acme Industries');
  assert.ok(await clickByName('Save'));
  await until(async () => (await stored()).items.some(item => item.name === 'Acme Industries'), 'the rename');
  const items = (await stored()).items;
  assert.equal(items.find(item => item.name === 'Acme Industries').id, 'acme-labs');
  assert.ok(!items.some(item => item.name === 'Acme Labs'));

  assert.ok(await clickByName('Add workspace'));
  await fillField('Name', 'nexprove ');
  assert.match(await session.panelText(), /already a workspace called/i);
  assert.equal(
    await session.panel.evaluate(
      () => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Save')?.disabled,
    ),
    true,
  );
  assert.ok(await clickByName('Cancel'));
  assert.equal((await stored()).items.filter(item => item.name.toLowerCase() === 'nexprove').length, 1);
});

test('new chats go where their words say, else to the default workspace', async () => {
  await session.panel.evaluate(() =>
    [...document.querySelectorAll('button[aria-pressed]')]
      .find(b => b.getAttribute('aria-label')?.includes('Acme Industries'))
      ?.click(),
  );
  await until(async () => (await stored()).defaultWorkspaceId === 'acme-labs', 'the new default');

  const byWords = await newChatSaying('Plan the Nexprove investor update', 'ws-a');
  assert.equal(byWords.workspaceId, 'nexprove');
  const byKeyword = await newChatSaying('Book the rocket sled test', 'ws-b');
  assert.equal(byKeyword.workspaceId, 'acme-labs');
  const byDefault = await newChatSaying('Summarise this page for me', 'ws-c');
  assert.equal(byDefault.workspaceId, 'acme-labs');
});

test('deleting the default workspace clears the default, and new chats go to none', async () => {
  await openWorkspaces();
  await session.panel.evaluate(() =>
    [...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith('Acme Industries'))?.click(),
  );
  assert.ok(await clickByName('Delete workspace'));
  await sleep(100);
  assert.ok(await clickByName('Delete workspace'));
  await until(async () => !(await stored()).items.some(item => item.id === 'acme-labs'), 'the delete');
  assert.equal((await stored()).defaultWorkspaceId, null);
  const afterDelete = await newChatSaying('Summarise another page', 'ws-d');
  assert.equal(afterDelete.workspaceId ?? null, null);
  assert.deepEqual(session.panelErrors, []);
});
