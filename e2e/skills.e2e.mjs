import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep, waitForThread } from './harness.mjs';

/**
 * End-to-end tests of skills: a playbook imported as a file loads on its site with no change to the
 * core, a turned-off one does not, /name calls one in, and teach mode writes one from a finished
 * task that the next task then uses.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const done = () => [{ done: { text: 'Scripted steps complete.', success: true } }];
const typeName = name => page => [
  { input_text: { intent: 'Fill the name', index: page.find('input', 'name'), text: name } },
];

const scenarios = {
  'skill-zedu': [done],
  'skill-off': [done],
  'skill-slash': [done],
  'teach-me': [typeName('Grace Hopper'), done],
  'teach-check': [done],
};

let mock;
let extension;
let options;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
  options = await extension.browser.newPage();
  await options.goto(`${extension.origin}/options.html`);
  await clickText(options, 'Skills');
  await options.waitForFunction(() => document.body.innerText.includes('/gmail'), { polling: 300, timeout: 10000 });
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

async function clickText(page, label) {
  await page.waitForFunction(
    label => [...document.querySelectorAll('button')].some(button => button.innerText.trim() === label),
    { polling: 300, timeout: 10000 },
    label,
  );
  await page.evaluate(
    label => [...document.querySelectorAll('button')].find(button => button.innerText.trim() === label).click(),
    label,
  );
}

/** The text of every model call of a scenario so far. */
const seenBy = name => mock.runs.get(name).requests.join('\n');

async function run(name, suffix = '') {
  mock.start(name);
  const session = await openSession(extension, mock);
  await session.send(`Run the scripted scenario ${name}.${suffix}`);
  await session.waitForEnd();
  return session;
}

test('an imported playbook loads on its site, with no change to the core', async () => {
  const input = await options.$('input[type="file"]');
  await input.uploadFile(path.join(here, 'zedu-operator.md'));
  await options.waitForFunction(() => document.body.innerText.includes('Imported /zedu-operator'), {
    polling: 300,
    timeout: 10000,
  });

  const session = await run('skill-zedu');
  const seen = seenBy('skill-zedu');
  assert.match(seen, /<skill name="zedu-operator">/);
  assert.match(seen, /Announcements go in #general, signed "— Avi"\./);
  assert.match(seen, /still waits for the user's confirmation/);
  assert.doesNotMatch(seen, /<skill name="gmail">/, 'skills for other sites stay out');
  assert.match(await session.panelText(), /Using skill \/zedu-operator/);
  await session.close();
});

test('a skill that is turned off does not load', async () => {
  await options.evaluate(() => {
    const row = [...document.querySelectorAll('li')].find(li => li.innerText.startsWith('/zedu-operator'));
    row.querySelector('input[type="checkbox"]').click();
  });
  await sleep(300);
  const session = await run('skill-off');
  assert.doesNotMatch(seenBy('skill-off'), /<skill name="zedu-operator">/);
  await session.close();
});

test('/name calls a skill in on any page', async () => {
  const session = await run('skill-slash', ' /gmail');
  assert.match(seenBy('skill-slash'), /<skill name="gmail">/);
  assert.match(await session.panelText(), /Using skill \/gmail/);
  await session.close();
});

test('after a task works, "Save as skill" writes a playbook the next task uses', async () => {
  const session = await run('teach-me');
  await session.panel.waitForSelector('section[aria-label="Save as skill"]', { timeout: 10000 });
  await clickText(session.panel, 'Save as skill');
  await session.panel.waitForSelector('#skill-draft', { timeout: 15000 });

  const taught = mock.kb.taught.at(-1);
  assert.match(taught, /User: Run the scripted scenario teach-me\./);
  assert.match(taught, /Pages: http:\/\/127\.0\.0\.1:\d+\/fixture\.html/);
  const draft = await session.panel.$eval('#skill-draft', el => el.value);
  assert.match(draft, /^---\nname: fixture-quotes\n/);
  assert.match(draft, /- The name field is the first box under "Quote request"\./);

  await clickText(session.panel, 'Save skill');
  await session.panel.waitForFunction(() => document.body.innerText.includes('call it with /fixture-quotes'), {
    polling: 300,
    timeout: 10000,
  });
  const saved = await extension.getStorage('skills');
  assert.equal(saved.skills.find(skill => skill.id === 'fixture-quotes')?.source, 'taught');

  // The offer is answered for this chat: opening it again does not show it
  const thread = await waitForThread(session.panel, 'teach-me');
  assert.ok(thread.tags.includes('skill:offered'));
  await session.panel.goto(`${extension.origin}/sidepanel.html?thread=${thread.id}`);
  await session.panel.waitForFunction(() => document.body.innerText.includes('E2E scenario finished'), {
    polling: 300,
    timeout: 10000,
  });
  await sleep(500);
  assert.equal(await session.panel.$('section[aria-label="Save as skill"]'), null);
  await session.close();

  const next = await run('teach-check');
  assert.match(seenBy('teach-check'), /<skill name="fixture-quotes">/);
  await next.close();
});
