import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Extensions only load in Chrome for Testing or Chromium; branded Chrome ignores --load-extension
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const builds = fs.existsSync(cache)
    ? fs
        .readdirSync(cache)
        .filter(name => /^chromium-\d+$/.test(name))
        .sort()
        .reverse()
    : [];
  for (const build of builds) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac', 'chrome-mac-x64']) {
      const exe = path.join(
        cache,
        build,
        arch,
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      );
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error('No Chrome for Testing found. Set CHROME_PATH to a Chrome for Testing or Chromium binary.');
}

/**
 * Starts a browser with the built extension loaded and its model pointed at the mock.
 */
export async function launchExtension(mock) {
  if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
    throw new Error('dist/ is missing. Run `pnpm build` first.');
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'avi-copilot-e2e-'));
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    userDataDir: profile,
    // Tall enough for the whole fixture: the agent is only shown the elements in view
    defaultViewport: { width: 1100, height: 1700 },
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
  });

  // Our service worker is the one whose manifest has a side panel
  let extensionId = null;
  for (let attempt = 0; attempt < 40 && !extensionId; attempt++) {
    for (const target of browser.targets().filter(t => t.type() === 'service_worker')) {
      const worker = await target.worker();
      const hasPanel = await worker.evaluate(() => Boolean(chrome.runtime.getManifest().side_panel)).catch(() => false);
      if (hasPanel) extensionId = new URL(target.url()).host;
    }
    if (!extensionId) await sleep(250);
  }
  if (!extensionId) throw new Error('The extension did not start');

  const origin = `chrome-extension://${extensionId}`;
  const options = await browser.newPage();
  await options.goto(`${origin}/options.html`);
  await options.evaluate(async baseUrl => {
    const model = { provider: 'mock', modelName: 'scripted' };
    await chrome.storage.local.set({
      'llm-api-keys': {
        providers: {
          mock: {
            name: 'mock',
            type: 'custom_openai',
            apiKey: 'test',
            baseUrl,
            modelNames: ['scripted'],
            createdAt: Date.now(),
          },
        },
      },
      'agent-models': { agents: { navigator: model, planner: model } },
    });
  }, mock.baseUrl);

  return {
    browser,
    origin,
    /** Sets which commit kinds ask for confirmation. */
    async setConfirm(confirm) {
      await options.evaluate(async confirm => {
        await chrome.storage.local.set({ 'gate-settings': { confirm } });
      }, confirm);
    },
    /** Writes extension storage directly, e.g. to set up usage or settings for a test. */
    setStorage: items => options.evaluate(items => chrome.storage.local.set(items), items),
    removeStorage: keys => options.evaluate(keys => chrome.storage.local.remove(keys), keys),
    async close() {
      await browser.close();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

/**
 * One task run: the fixture page in the active tab, and the side panel driven from a second tab.
 */
export async function openSession(extension, mock, query = '') {
  const web = await extension.browser.newPage();
  await web.goto(mock.fixtureUrl + query);
  const panel = await extension.browser.newPage();
  const panelErrors = [];
  panel.on('pageerror', error => panelErrors.push(String(error)));
  await panel.goto(`${extension.origin}/sidepanel.html`);
  await panel.waitForSelector('textarea');
  // The agent acts on the active tab
  await web.bringToFront();

  const panelText = async () => (await panel.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');

  return {
    web,
    panel,
    panelErrors,
    panelText,
    /** Types a task into the panel and sends it. */
    async send(task) {
      await panel.evaluate(text => {
        const input = document.querySelector('textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, task);
      await sleep(200);
      await panel.evaluate(() => {
        [...document.querySelectorAll('button')].find(button => button.innerText.trim() === 'Send').click();
      });
    },
    /** Waits for the confirm card and returns its text. */
    async waitForCard(timeout = 30000) {
      const card = await panel.waitForSelector('[role="alertdialog"]', { timeout });
      return (await card.evaluate(el => el.innerText)).replace(/\s+/g, ' ');
    },
    /** Clicks a button on the confirm card. */
    async answer(label) {
      await panel.evaluate(label => {
        const card = document.querySelector('[role="alertdialog"]');
        [...card.querySelectorAll('button')].find(button => button.innerText.trim() === label).click();
      }, label);
    },
    /** Waits until the task has ended, one way or another, and returns the panel text. */
    async waitForEnd(timeout = 60000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const text = await panelText();
        if (/E2E scenario finished|Task cancell?ed|Task failed/i.test(text)) return text;
        await sleep(300);
      }
      throw new Error(`The task did not end. Panel shows: ${await panelText()}`);
    },
    hasCard: () => panel.evaluate(() => document.querySelector('[role="alertdialog"]') !== null),
    events: () => web.evaluate(() => window.__events),
    async close() {
      await panel.close();
      await web.close();
    },
  };
}

export { sleep };
