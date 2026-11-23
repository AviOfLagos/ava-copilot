// Records a short demo of voice living in a chat: the real extension with the mock model and mock Gemini Live, the
// tab in front on the left and that tab's own Ava side panel on the right, stitched into an mp4 with ffmpeg.
// Run by hand after `pnpm build`: node e2e/manual/voice-per-chat-demo.mjs <out.mp4>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, sleep } from '../harness.mjs';

process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = resolve(import.meta.dirname, '..', 'hey-ava.wav');

const out = process.argv[2] ?? join(process.cwd(), 'voice-per-chat-demo.mp4');
const mock = await startMockLlm({
  'zebra-invoice': [() => [{ done: { text: 'The zebra invoice total is 240 dollars.', success: true } }]],
  'pay-step': [() => [{ done: { text: 'Paid the zebra invoice: 240 dollars.', success: true } }]],
});
const extension = await launchExtension(mock);
const { browser, origin } = extension;
const worker = await (
  await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(origin))
).worker();
const providers = await extension.getStorage('llm-api-keys');
await extension.setStorage({
  'llm-api-keys': {
    providers: {
      ...providers.providers,
      gemini: { name: 'Gemini', type: 'gemini', apiKey: 'test-key', modelNames: ['gemini-3.8-flash'], createdAt: 1 },
    },
  },
  'voice-engine-settings': { mode: 'live', modeChosen: true },
  'meeting-settings': {
    liveModel: 'gemini-3.8-live',
    autoNotes: false,
    liveEndpoint: `ws://127.0.0.1:${mock.port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`,
  },
});
const frames = [];
const dir = mkdtempSync(join(tmpdir(), 'voice-per-chat-demo-'));

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
async function frame(tabPage, tabId, caption, hold = 3, showPanel = true) {
  await sleep(600);
  await tabPage.setViewport({ width: 860, height: 760 });
  const left = await tabPage.screenshot({ encoding: 'base64' });
  const panel = showPanel ? await panelOf(tabId) : null;
  const right = panel ? await panel.screenshot({ encoding: 'base64' }) : null;
  await stage.setContent(`<!doctype html><body style="margin:0;font:15px system-ui;background:#111;color:#eee">
    <div style="height:84px;display:flex;align-items:center;padding:0 24px;font-size:22px;font-weight:600">${caption}</div>
    <div style="display:flex;height:776px">
      <div style="width:860px"><div style="height:16px;font-size:11px;color:#9aa;padding-left:8px">Tab in front: ${tabPage.url()}</div>
        <img style="width:860px;height:760px" src="data:image/png;base64,${left}"></div>
      <div style="width:420px;border-left:1px solid #333">
        <div style="height:16px;font-size:11px;color:#9aa;padding-left:8px">Ava panel of this tab</div>
        ${
          right
            ? `<img style="width:420px;height:760px" src="data:image/png;base64,${right}">`
            : `<div style="height:760px;display:flex;align-items:center;justify-content:center;text-align:center;color:#889;padding:24px;box-sizing:border-box">No Ava panel on this tab.<br><br>Voice is paused: the mic is off.</div>`
        }
      </div></div></body>`);
  const file = join(dir, `${String(frames.length).padStart(2, '0')}.png`);
  await stage.screenshot({ path: file });
  frames.push({ file, hold });
}
const click = (page, label) =>
  page.evaluate(label => {
    const button = [...document.querySelectorAll('button')].find(
      b => b.innerText.trim() === label || b.getAttribute('aria-label') === label,
    );
    if (!button) throw new Error(`No button "${label}"`);
    button.click();
  }, label);
const text = page => page.evaluate(() => document.body.innerText);
let panel = null;
async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(300);
  }
  throw new Error(
    `demo step timed out. Panel: ${(await text(panel).catch(() => '')).replace(/\s+/g, ' ').slice(0, 800)}`,
  );
}

// 1. A chat about an invoice
const a = await browser.newPage();
await a.goto(mock.fixtureUrl);
const aId = await activeTabId();
await openAva(aId);
panel = await panelOf(aId);
await panel.waitForSelector('textarea');
mock.start('zebra-invoice');
await panel.evaluate(text => {
  const input = document.querySelector('textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, 'Run the scripted scenario zebra-invoice: check the zebra invoice total');
await sleep(300);
await click(panel, 'Send');
await until(async () => /E2E scenario finished/.test(await text(panel)));
await frame(a, aId, '1. A typed chat: Ava checked the invoice');

// 2. The mic in that chat: same conversation, out loud
mock.live.voiceRequest = 'Now pay it';
mock.live.voiceTool = {
  name: 'run_browser_task',
  args: { task: 'Run the scripted scenario pay-step: pay the zebra invoice' },
};
mock.start('pay-step');
await click(panel, 'Talk to Ava');
await until(() => mock.live.sessions.some(s => s.voice));
await frame(a, aId, '2. The mic in this chat: Ava talks here, and already knows the invoice');
await until(() => mock.live.toolResponses.length > 0);
await click(panel, 'Type in this conversation').catch(() => {});
await until(async () => ((await text(panel)).match(/E2E scenario finished/g) ?? []).length >= 2);
await frame(a, aId, '3. Said out loud, "Now pay it": it runs in the same chat, spoken and typed lines together', 4);

// 3. Another tab: Ava pauses; back: she picks up
mock.live.voiceTool = { name: 'get_status', args: {} };
const c = await browser.newPage();
await c.goto(`${mock.fixtureUrl}?other=1`);
const cId = await activeTabId();
await until(() => mock.live.sessions.find(s => s.voice).closed);
await frame(c, cId, '4. On another tab, voice pauses: mic off, nothing billed', 3, false);
await activate(aId);
await until(async () => /Voice is back/.test(await text(panel)));
await frame(a, aId, '5. Back on the chat’s tab: “picking up where we were”', 4);

// 4. A new chat: voice moves there and knows the recent chats
await click(panel, 'New thread');
await sleep(600);
await click(panel, 'Talk to Ava');
await until(() => mock.live.sessions.filter(s => s.voice).length >= 3);
await click(panel, 'Type in this conversation').catch(() => {});
await frame(a, aId, '6. The mic on a new chat: a fresh talk that remembers your recent chats', 4);

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
