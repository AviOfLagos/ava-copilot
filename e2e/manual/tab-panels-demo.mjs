// Records a short demo of tab-scoped chats: the real extension in Chrome for Testing, the tab in front on the left
// and that tab's own Ava side panel on the right (its real panel document), stitched into an mp4 with ffmpeg.
// Run by hand after `pnpm build`: node e2e/manual/tab-panels-demo.mjs <out.mp4>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, sleep } from '../harness.mjs';

const out = process.argv[2] ?? join(process.cwd(), 'tab-panels-demo.mp4');
let otherSite = '';
const mock = await startMockLlm({
  'other-site': [
    () => [{ go_to_url: { intent: 'Open the other site', url: otherSite } }],
    () => [{ done: { text: 'Found it on the other site. Your page stayed as it was.', success: true } }],
  ],
});
otherSite = mock.fixtureUrl.replace('127.0.0.1', 'other.localhost') + '?other=1';
const extension = await launchExtension(mock);
const { browser, origin } = extension;
const worker = await (
  await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(origin))
).worker();
const frames = [];
const dir = mkdtempSync(join(tmpdir(), 'tab-panels-demo-'));

const activeTabId = () =>
  worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
const activate = id => worker.evaluate(id => chrome.tabs.update(id, { active: true }), id);

// The toolbar click, as a real user gesture: a button on an extension page opens the panel on a tab
const opener = await browser.newPage();
await opener.goto(`${origin}/options.html`);
const openerTab = await activeTabId();
await opener.evaluate(() => {
  const b = document.createElement('button');
  b.id = 'open-ava';
  b.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;width:120px;height:60px';
  b.onclick = () => {
    const tabId = window.__tab;
    chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tab=${tabId}`, enabled: true });
    void chrome.sidePanel.open({ tabId });
  };
  document.body.appendChild(b);
});
async function openAva(tabId) {
  await activate(openerTab);
  await opener.evaluate(id => (window.__tab = id), tabId);
  await opener.click('#open-ava');
  await sleep(800);
  await activate(tabId);
  await sleep(800);
}

async function panelOf(tabId) {
  const target = browser.targets().find(t => t.url().endsWith(`sidepanel.html?tab=${tabId}`));
  if (!target) return null;
  const page = await target.asPage();
  await page.setViewport({ width: 420, height: 760 });
  return page;
}

const stage = await browser.newPage();
await stage.setViewport({ width: 1280, height: 860 });
async function frame(tabPage, tabId, caption, hold = 3) {
  await sleep(500);
  await tabPage.setViewport({ width: 860, height: 760 });
  const left = await tabPage.screenshot({ encoding: 'base64' });
  const panel = await panelOf(tabId);
  const right = panel ? await panel.screenshot({ encoding: 'base64' }) : null;
  const url = tabPage.url();
  await stage.setContent(`<!doctype html><body style="margin:0;font:15px system-ui;background:#111;color:#eee">
    <div style="height:84px;display:flex;align-items:center;padding:0 24px;font-size:22px;font-weight:600">${caption}</div>
    <div style="display:flex;gap:0;height:776px">
      <div style="width:860px"><div style="height:16px;font-size:11px;color:#9aa;padding-left:8px">Tab in front: ${url}</div>
        <img style="width:860px;height:760px" src="data:image/png;base64,${left}"></div>
      <div style="width:420px;border-left:1px solid #333">
        <div style="height:16px;font-size:11px;color:#9aa;padding-left:8px">Ava panel of this tab</div>
        ${
          right
            ? `<img style="width:420px;height:760px" src="data:image/png;base64,${right}">`
            : `<div style="height:760px;display:flex;align-items:center;justify-content:center;text-align:center;color:#889;padding:24px;box-sizing:border-box">No Ava panel on this tab</div>`
        }
      </div></div></body>`);
  const file = join(dir, `${String(frames.length).padStart(2, '0')}.png`);
  await stage.screenshot({ path: file });
  frames.push({ file, hold });
}

async function type(panel, text) {
  await panel.evaluate(text => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
}

// 1. Ava opened on tab A: a fresh start
const a = await browser.newPage();
await a.goto(mock.fixtureUrl);
const aId = await activeTabId();
await openAva(aId);
let panelA = await panelOf(aId);
await panelA.waitForSelector('textarea');
await frame(a, aId, '1. Ava opens on this tab only: new conversation, or carry one on');

// 2. A task about another site
mock.start('other-site');
await type(panelA, 'Find this on the other site');
await sleep(300);
await frame(a, aId, '2. Asking, from tab A, for something on another site');
await panelA.evaluate(() =>
  [...document.querySelectorAll('button')]
    .find(b => b.getAttribute('aria-label') === 'Send' || b.innerText.trim() === 'Send')
    .click(),
);
for (let i = 0; i < 60; i++) {
  if (/E2E scenario finished|Found it on the other site/.test(await panelA.evaluate(() => document.body.innerText)))
    break;
  await sleep(500);
}
const bId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, otherSite);
const b = (await browser.pages()).find(page => page.url() === otherSite);
await frame(b, bId, '3. Ava opened a NEW tab for the other site; one click on Ava there shows this chat');

// 3. Back to tab A: the page never moved, the panel is as it was
await activate(aId);
await type(panelA, 'and a draft I was writing');
await frame(a, aId, '4. Back on tab A: same page, same chat, the answer is here');

// 4. Another tab: no panel until Ava is opened there
const c = await browser.newPage();
await c.goto(mock.fixtureUrl + '?second=1');
const cId = await activeTabId();
await frame(c, cId, '5. Switching to another tab hides Ava there');
await activate(aId);
await frame(a, aId, '6. Switching back shows it again, exactly where it was (draft kept)');

// 5. Ava opened on tab C: past conversations with their page; open one here
await openAva(cId);
const panelC = await panelOf(cId);
await panelC.waitForSelector('textarea');
await sleep(800);
await frame(c, cId, '7. Ava on a new tab: start fresh, or pick a past chat (with its page)');
await panelC.evaluate(() =>
  [...document.querySelectorAll('button')].find(b => b.innerText.includes('Find this on the other site')).click(),
);
await sleep(1200);
await frame(c, cId, '8. The chat now lives on this tab');
await activate(aId);
panelA = await panelOf(aId);
await sleep(800);
await frame(a, aId, '9. Tab A says the chat moved; one chat never drives another chat’s tab', 4);

const list = frames.map(f => `file '${f.file}'\nduration ${f.hold}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
writeFileSync(join(dir, 'list.txt'), list);
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  '-f',
  'concat',
  '-safe',
  '0',
  '-i',
  join(dir, 'list.txt'),
  '-vf',
  'fps=10,format=yuv420p',
  out,
]);
console.log('wrote', out, 'frames in', dir);
await extension.close();
await mock.close();
