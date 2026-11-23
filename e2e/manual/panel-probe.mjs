// Probe: what Chrome does with per-tab side panels when tabs switch. Not a test; run by hand.
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, sleep } from '../harness.mjs';

const mock = await startMockLlm({});
const extension = await launchExtension(mock);
const { browser, origin } = extension;
const worker = await (
  await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(origin))
).worker();
const panels = () =>
  browser
    .targets()
    .map(t => t.url())
    .filter(u => u.includes('sidepanel.html'));

const a = await browser.newPage();
await a.goto(`${origin}/options.html`);
const aId = await worker.evaluate(
  async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id,
);
await a.evaluate(id => {
  const b = document.createElement('button');
  b.id = 'probe';
  b.textContent = 'open';
  b.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;width:200px;height:80px';
  b.onclick = () => {
    chrome.sidePanel.setOptions({ tabId: id, path: `sidepanel.html?tab=${id}`, enabled: true });
    chrome.sidePanel.open({ tabId: id }).then(
      () => (window.__opened = 'ok'),
      e => (window.__opened = String(e)),
    );
  };
  document.body.appendChild(b);
}, aId);
await a.click('#probe');
await sleep(1500);
console.log('open result', await a.evaluate(() => window.__opened), 'panels', panels());

const b = await browser.newPage();
await b.goto(mock.fixtureUrl);
const bId = await worker.evaluate(
  async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id,
);
await sleep(1000);
console.log('on B (no panel set)', panels());
await worker.evaluate(
  id => chrome.sidePanel.setOptions({ tabId: id, path: `sidepanel.html?tab=${id}`, enabled: true }),
  bId,
);
await sleep(1000);
console.log('on B after enabling B', panels());
await a.bringToFront();
await worker.evaluate(id => chrome.tabs.update(id, { active: true }), aId);
await sleep(1500);
console.log('back on A', panels());
await worker.evaluate(id => chrome.tabs.update(id, { active: true }), bId);
await sleep(1500);
console.log('on B again', panels());
// The agent opens a new tab from A, active
await worker.evaluate(id => chrome.tabs.update(id, { active: true }), aId);
await sleep(1000);
const cId = await worker.evaluate(async () => {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  await chrome.sidePanel.setOptions({ tabId: tab.id, path: `sidepanel.html?tab=${tab.id}`, enabled: true });
  return tab.id;
});
await sleep(1500);
console.log('new tab C opened from A, enabled', cId, panels());
console.log(
  'open on C without a gesture:',
  await worker.evaluate(
    id =>
      chrome.sidePanel.open({ tabId: id }).then(
        () => 'ok',
        e => String(e),
      ),
    cId,
  ),
);
await sleep(1500);
console.log('after open on C', panels());
await extension.close();
await mock.close();
