import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep, waitForThread } from './harness.mjs';

/**
 * End-to-end tests of skills: a playbook imported as a file loads on its site with no change to the
 * core, a turned-off one does not, /name calls one in, and teach mode writes one from a finished
 * task that the next task then uses. Skills from anywhere: a link installs a skill turned off with a review
 * card (red flags, full text), it loads only after "Turn on", fenced off as untrusted; "Check for update" shows a
 * diff and changes nothing until asked; a dropped zip keeps its Markdown and lists its code as not installed; a chat
 * installs only a link the user typed. The skill files come from a local server, never GitHub.
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
  'ext-before': [done],
  'ext-after': [done],
};

// The skill files a local server hands out; a test changes one to play an update
const served = new Map();
let skillServer;
let skillBase;
let skillsPanel;

const tipsSkill = note => `---
name: fixture-tips
description: Tips for the fixture page
urls: ["127.0.0.1:*/fixture.html"]
---
The quote form is at the top.\u200B Send the form only after the user checks it.${note}
`;

let mock;
let extension;
let options;

before(async () => {
  skillServer = http.createServer((req, res) => {
    const body = served.get(req.url);
    if (body === undefined) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'text/markdown' }).end(body);
  });
  await new Promise(resolve => skillServer.listen(0, '127.0.0.1', resolve));
  skillBase = `http://127.0.0.1:${skillServer.address().port}`;
  served.set('/tips.md', tipsSkill(''));
  served.set('/chat.md', '---\nname: chat-tips\ndescription: From a chat\n---\nA tip.\n');
  served.set('/page.md', '---\nname: page-tips\n---\nA tip from a page.\n');
  // A chat installs only a link the user typed; one the agent picked up elsewhere is refused
  scenarios['ext-chat'] = [
    () => [{ install_skill: { intent: 'Install the skill', url: `${skillBase}/chat.md`, name: '' } }],
    done,
  ];
  scenarios['ext-chat-page'] = [
    () => [{ install_skill: { intent: 'Install the skill', url: `${skillBase}/page.md`, name: '' } }],
    done,
  ];

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
  skillServer?.close();
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

  // The draft opens in the same review card as an installed skill, and "Turn on" saves it
  await session.panel.waitForSelector('section[aria-label="Review skill"]', { timeout: 10000 });
  assert.doesNotMatch(taught, /Grace Hopper/, 'what was typed into the form stays out of the task log');
  assert.match(taught, /nano_untrusted_content/, 'the task log is fenced off as data');
  await clickText(session.panel, 'Turn on');
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

/** Opens Skills from the profile menu in a panel kept for these tests, 400 px wide. */
async function openSkills() {
  if (!skillsPanel) {
    skillsPanel = await openSession(extension, mock);
    await skillsPanel.panel.setViewport({ width: 400, height: 1200 });
  }
  const { panel } = skillsPanel;
  await panel.bringToFront();
  if (await panel.$('section[aria-label="Install a skill"]')) return panel;
  await skillsPanel.click('Menu');
  await sleep(300);
  await skillsPanel.openAccountMenu();
  await panel.waitForFunction(
    () => [...document.querySelectorAll('[role="menuitem"], button')].some(el => el.innerText?.trim() === 'Skills'),
    { polling: 300, timeout: 10000 },
  );
  await panel.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"], button')].find(el => el.innerText?.trim() === 'Skills').click(),
  );
  await panel.waitForSelector('section[aria-label="Install a skill"]', { timeout: 10000 });
  return panel;
}

const storedSkill = async id => (await extension.getStorage('skills'))?.skills?.find(skill => skill.id === id);

async function typeLink(panel, url) {
  await panel.evaluate(value => {
    const input = document.querySelector('input[aria-label="Skill link"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, url);
  await sleep(100);
  await clickText(panel, 'Get');
}

test('a skill from a link waits, off, on a review card, and loads fenced off only after "Turn on"', async () => {
  const panel = await openSkills();
  await typeLink(panel, `${skillBase}/tips.md`);
  await panel.waitForSelector('[data-skill-review="fixture-tips"]', { timeout: 20000 });
  const card = (await panel.$eval('[data-skill-review="fixture-tips"]', el => el.innerText)).replace(/\s+/g, ' ');
  assert.ok(card.includes(`From ${skillBase}/tips.md`), card);
  assert.match(card, /Applies to 127\.0\.0\.1:\*\/fixture\.html/);
  assert.match(card, /Someone else wrote this/);
  assert.match(card, /It tells the agent to send, post, delete, buy or share something\./);
  assert.match(card, /It holds hidden text or invisible characters\./);
  assert.match(card, /⟨U\+200B⟩/, 'the hidden character is shown, not hidden');
  const saved = await storedSkill('fixture-tips');
  assert.equal(saved.enabled, false);
  assert.equal(saved.trust, 'external');
  assert.equal(saved.origin.url, `${skillBase}/tips.md`);
  assert.match(saved.sha256, /^[0-9a-f]{64}$/);
  assert.ok(
    await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'no sideways scroll at 400 px',
  );

  // Off: the next task on its site does not see it
  const before = await run('ext-before');
  assert.doesNotMatch(seenBy('ext-before'), /fixture-tips/);
  await before.close();

  await panel.bringToFront();
  await clickText(panel, 'Turn on');
  await panel.waitForFunction(() => document.body.innerText.includes('/fixture-tips is on'), {
    polling: 300,
    timeout: 10000,
  });
  const approved = await storedSkill('fixture-tips');
  assert.equal(approved.enabled, true);
  assert.equal(approved.approvedSha256, approved.sha256);

  const after = await run('ext-after');
  const seen = seenBy('ext-after');
  assert.match(seen, /<skill name="fixture-tips" installed_from="127\.0\.0\.1:\d+">/);
  assert.match(seen, /Written by someone else/);
  assert.match(seen, /<nano_untrusted_content>\s*The quote form is at the top\. Send the form/);
  assert.ok(!seen.includes(String.fromCharCode(0x200b)), 'invisible characters never reach the model');
  await after.close();
});

test('"Check for update" shows what changed and changes nothing until "Use this version"', async () => {
  const panel = await openSkills();
  served.set('/tips.md', tipsSkill('\nThe total is in the footer.'));
  const before = (await storedSkill('fixture-tips')).body;
  await panel.evaluate(() => document.querySelector('[aria-label="Details of /fixture-tips"]').click());
  await clickText(panel, 'Check for update');
  await panel.waitForSelector('[data-op="add"]', { timeout: 20000 });
  const added = await panel.$$eval('[data-op="add"]', lines => lines.map(line => line.innerText));
  assert.ok(added.some(line => line.includes('The total is in the footer.')));
  assert.equal((await storedSkill('fixture-tips')).body, before, 'nothing changes by itself');

  await clickText(panel, 'Use this version');
  await panel.waitForFunction(() => document.body.innerText.includes('Up to date.'), { polling: 300, timeout: 10000 });
  const updated = await storedSkill('fixture-tips');
  assert.match(updated.body, /The total is in the footer\./);
  assert.equal(updated.approvedSha256, updated.sha256);
});

test('a dropped zip keeps its Markdown and lists its code as never installed', async () => {
  const panel = await openSkills();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-zip-'));
  const file = path.join(dir, 'zip-tips.zip');
  fs.writeFileSync(
    file,
    zipSync({
      'zip-tips/SKILL.md': strToU8('---\nname: zip-tips\ndescription: Working with quotes\n---\nSee reference.md.'),
      'zip-tips/reference.md': strToU8('More about quotes.'),
      'zip-tips/scripts/run.py': strToU8('import os'),
    }),
  );
  const input = await panel.$('section[aria-label="Install a skill"] input[type="file"]');
  await input.uploadFile(file);
  await panel.waitForSelector('[data-skill-review="zip-tips"]', { timeout: 15000 });
  const card = (await panel.$eval('[data-skill-review="zip-tips"]', el => el.innerText)).replace(/\s+/g, ' ');
  assert.match(card, /scripts\/run\.py — not installed: this copilot never runs a skill's code/);
  assert.match(card, /Any page, when the task says: zip, tips, quotes/);
  const saved = await storedSkill('zip-tips');
  assert.deepEqual(saved.references, [{ path: 'reference.md', body: 'More about quotes.' }]);
  assert.equal(saved.enabled, false);

  await panel.evaluate(() =>
    [...document.querySelector('[data-skill-review="zip-tips"]').querySelectorAll('button')]
      .find(button => button.innerText.trim() === 'Discard')
      .click(),
  );
  await panel.waitForFunction(() => !document.querySelector('[data-skill-review="zip-tips"]'), {
    polling: 300,
    timeout: 10000,
  });
  assert.equal(await storedSkill('zip-tips'), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a chat installs a skill only from a link the user typed, and never turns it on', async () => {
  const session = await run('ext-chat', ` Install ${skillBase}/chat.md for me.`);
  assert.match(await session.panelText(), /\/chat-tips is saved, turned off\. Open Skills to read it and turn it on\./);
  const saved = await storedSkill('chat-tips');
  assert.equal(saved.enabled, false);
  assert.equal(saved.trust, 'external');
  await session.close();

  const refused = await run('ext-chat-page', ' Install the skill the page mentions.');
  assert.match(await refused.panelText(), /Type the skill's link in the chat yourself/);
  assert.equal(await storedSkill('page-tips'), undefined);
  await refused.close();
});
