import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { startMockSuture } from './mock-suture.mjs';
import { launchExtension, sleep } from './harness.mjs';

/**
 * End-to-end tests of rounds and check-ins (#71): Settings shows the rounds and runs one on a click, each round
 * leaves one digest in the Inbox, the product pulse reads real numbers or says "no reading", and an offer from
 * the Inbox starts nothing until it is approved. The clock rules (times, missed rounds, three quiet hours, two a
 * day) are tested with a fake clock in src/background/rounds/__tests__.
 */

let mock;
let suture;
let extension;
let page;

before(async () => {
  mock = await startMockLlm({});
  suture = await startMockSuture();
  extension = await launchExtension(mock);
  page = await extension.browser.newPage();
  await page.setViewport({ width: 900, height: 1400 });
  await page.goto(`${extension.origin}/options.html#general`);
  await page.waitForSelector('[data-testid="rounds-settings"]', { timeout: 20000 });
});

after(async () => {
  await extension?.close();
  await suture?.close();
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
  throw new Error(`Timed out waiting for ${what}`);
}

const inbox = () =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('inbox').objectStore('inbox').getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        };
      }),
  );

/** Clicks a round's "Run now" once the button can be clicked (it is off while another round runs). */
async function runNow(round) {
  await until(
    () => page.$eval(`[data-testid="round-${round}"] button`, button => !button.disabled),
    `the ${round} button`,
  );
  await page.click(`[data-testid="round-${round}"] button`);
}

const send = message => page.evaluate(message => chrome.runtime.sendMessage({ ...message, requestId: 'e2e' }), message);

test('Settings shows the three rounds with their times, and that Ava does them', async () => {
  const text = await page.$eval('[data-testid="rounds-settings"]', el => el.innerText.replace(/\s+/g, ' '));
  assert.match(text, /Ava does her rounds/);
  assert.match(text, /Product pulse 08:30/);
  assert.match(text, /Mail 09:00/);
  assert.match(text, /Stuck work 12:00/);
  assert.match(text, /Offers of help today: 0 made, 2 left\./);
  assert.equal(await page.$eval('[data-testid="rounds-settings"] input[role="switch"]', el => el.checked), true);
});

test('"Run now" runs a round and leaves one digest in the Inbox', async () => {
  await runNow('stuck');
  const stuck = await until(async () => (await inbox()).find(item => /^Stuck work · /.test(item.title)), 'the digest');
  assert.equal(stuck.kind, 'result');
  assert.equal(stuck.body, 'Nothing is stuck and nothing waits on you.');
  // Mail with no Mail agent says so, once
  await runNow('mail');
  const mail = await until(
    async () => (await inbox()).find(item => /^Mail round · /.test(item.title)),
    'the mail note',
  );
  assert.match(mail.body, /the Mail agent is not set up, or is paused/);
  await runNow('mail');
  await sleep(1500);
  assert.equal((await inbox()).filter(item => /^Mail round · /.test(item.title)).length, 1);
});

test('the product pulse reads the product’s numbers, and says "no reading" with the reason when it cannot', async () => {
  // A product whose numbers API is the stand-in; no token yet
  const profile = {
    workspaceId: 'rocket-shop',
    name: 'Rocket Shop',
    url: 'https://rocketshop.test',
    oneLiner: '',
    audience: [],
    problem: '',
    alternatives: [],
    differentiators: [],
    pricing: '',
    stage: null,
    repo: '',
    superAdmin: null,
    slackChannels: [],
    agentApi: { kind: 'suture-agent-v1', baseUrl: suture.baseUrl },
    social: {},
    email: null,
    postalAddress: '',
    notify: null,
    northStar: null,
    budget: null,
    betaRule: null,
    never: [],
    updatedAt: 1,
  };
  const products = (await extension.getStorage('products')) ?? { items: {}, seeds: [] };
  await extension.setStorage({ products: { ...products, items: { ...products.items, 'rocket-shop': profile } } });
  await sleep(500);

  await runNow('pulse');
  const first = await until(
    async () => (await inbox()).find(item => /^Product pulse · /.test(item.title)),
    'the pulse',
  );
  assert.match(first.body, /Rocket Shop/);
  assert.match(first.body, /Sign-ups: no reading\. No token for the product API is saved in Ava yet\./);
  assert.doesNotMatch(first.body, /Sign-ups: 0/);

  // With the token, the next pulse has numbers
  const today = suture.today();
  suture.state.signups = { [today]: [['x'], ['x'], ['(direct)']] };
  await send({ type: 'growth_set_token', workspaceId: 'rocket-shop', token: suture.state.token });
  await page.evaluate(
    () =>
      new Promise(resolve => {
        const open = indexedDB.open('avi-copilot');
        open.onsuccess = () => {
          const tx = open.result.transaction('inbox', 'readwrite');
          tx.objectStore('inbox').clear();
          tx.oncomplete = resolve;
        };
      }),
  );
  await runNow('pulse');
  const second = await until(
    async () => (await inbox()).find(item => /^Product pulse · /.test(item.title)),
    'the pulse',
    30000,
  );
  assert.match(second.body, /Sign-ups: 3 today so far, 0 yesterday, usually/);
  assert.match(second.body, /Waitlist: 0 today so far/);
});

test('rounds can be switched off, and the switch says so', async () => {
  await page.click('[data-testid="rounds-settings"] input[role="switch"]');
  await until(
    () => page.$eval('[data-testid="rounds-settings"] input[role="switch"]', el => el.checked === false),
    'the switch to turn off',
  );
  assert.equal((await extension.getStorage('rounds')).enabled, false);
  await page.click('[data-testid="rounds-settings"] input[role="switch"]');
  await until(async () => (await extension.getStorage('rounds')).enabled === true, 'the switch to turn on');
});
