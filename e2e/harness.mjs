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
    // Tab audio capture needs a real window; E2E_HEADED=1 shows one
    headless: !process.env.E2E_HEADED,
    userDataDir: profile,
    // Tall enough for the whole fixture: the agent is only shown the elements in view
    defaultViewport: { width: 1100, height: 1700 },
    // A pipe and unsafe extension debugging let tests press the toolbar button (Extensions.triggerAction)
    pipe: true,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--no-first-run',
      '--enable-unsafe-extension-debugging',
      '--autoplay-policy=no-user-gesture-required',
      // A fake microphone for the voice tests; it breaks tab capture, so only those tests use it
      ...(process.env.E2E_FAKE_MIC ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : []),
      // A recording played as the microphone, on a loop: the wake word test says "Hey Ava" with it
      // (the audio service's sandbox would not let it read the file, and it would play silence)
      ...(process.env.E2E_FAKE_AUDIO_FILE
        ? [
            `--use-file-for-fake-audio-capture=${process.env.E2E_FAKE_AUDIO_FILE}`,
            '--disable-features=AudioServiceSandbox',
          ]
        : []),
    ],
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
    getStorage: key => options.evaluate(async key => (await chrome.storage.local.get(key))[key], key),
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

  const session = {
    web,
    panel,
    panelErrors,
    panelText,
    /** Types a task into the panel and sends it, with this session's page as the active tab. */
    async send(task) {
      await session.web.bringToFront();
      await panel.evaluate(text => {
        const input = document.querySelector('textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, task);
      await sleep(200);
      await panel.evaluate(() => {
        [...document.querySelectorAll('button')]
          .find(button => button.innerText.trim() === 'Send' || button.getAttribute('aria-label') === 'Send')
          .click();
      });
    },
    /** Waits for the confirm card and returns its text. */
    async waitForCard(timeout = 30000) {
      const card = await panel.waitForSelector('[role="alertdialog"]', { timeout });
      return (await card.evaluate(el => el.innerText)).replace(/\s+/g, ' ');
    },
    /** Clicks a button on the confirm card. Confirming a commit takes a second click. */
    async answer(label) {
      await panel.evaluate(label => {
        const card = document.querySelector('[role="alertdialog"]');
        [...card.querySelectorAll('button')].find(button => button.innerText.trim() === label).click();
      }, label);
      await sleep(50);
      await panel.evaluate(() => {
        const card = document.querySelector('[role="alertdialog"]');
        [...(card?.querySelectorAll('button') ?? [])]
          .find(button => button.innerText.trim() === 'Click again to confirm')
          ?.click();
      });
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
    /** Clicks a button in the panel by its visible text or accessible name. */
    async click(label) {
      await panel.evaluate(label => {
        const button = [...document.querySelectorAll('button')].find(b => {
          const text = b.innerText.trim();
          return text === label || text.startsWith(`${label}\n`) || b.getAttribute('aria-label') === label;
        });
        if (!button) throw new Error(`No button "${label}"`);
        button.click();
      }, label);
    },
    events: () => session.web.evaluate(() => window.__events),
    async close() {
      await panel.close();
      await session.web.close();
    },
  };
  return session;
}

/**
 * Reads the threads table straight from the extension's IndexedDB, through an extension page.
 */
export function readThreads(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('avi-copilot');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('threads').objectStore('threads').getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/** Waits until a thread whose title contains `text` matches `predicate`, and returns it. */
export async function waitForThread(page, text, predicate = () => true, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const thread = (await readThreads(page)).find(t => t.title.includes(text) && predicate(t));
    if (thread) return thread;
    await sleep(200);
  }
  throw new Error(`No thread "${text}" reached the expected state`);
}

/**
 * Stops the extension's service worker, as Chrome does after 30 seconds idle, then wakes it the
 * way any extension event would.
 */
export async function restartServiceWorker(extension, page) {
  const session = await page.createCDPSession();
  const versions = [];
  session.on('ServiceWorker.workerVersionUpdated', event => versions.push(...event.versions));
  await session.send('ServiceWorker.enable');
  await sleep(300);
  for (const version of versions.filter(
    v => v.scriptURL.startsWith(extension.origin) && v.runningStatus === 'running',
  )) {
    await session.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  }
  await session.detach();
  await sleep(500);
  await page.evaluate(() => chrome.runtime.connect({ name: 'wake' }));

  // Puppeteer holds a new worker until a debugger releases it. Chrome itself never does this, so
  // release it here, or the restarted worker would never run.
  await sleep(500);
  const browserSession = await extension.browser.target().createCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets');
  const worker = targetInfos.find(info => info.type === 'service_worker' && info.url.startsWith(extension.origin));
  if (worker) {
    const { sessionId } = await browserSession.send('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: true,
    });
    await browserSession.connection().session(sessionId).send('Runtime.runIfWaitingForDebugger');
  }
  await browserSession.detach();
}

/**
 * Presses the extension's toolbar button on a page's tab, as the user would. That opens the side
 * panel and lets the extension record the tab. Returns the side panel page.
 */
export async function pressToolbarButton(extension, page) {
  const session = await extension.browser.target().createCDPSession();
  const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = targetInfos.find(info => info.url === page.url());
  if (!tab) throw new Error(`No tab for ${page.url()}`);
  await session.send('Extensions.triggerAction', { id: new URL(extension.origin).host, targetId: tab.targetId });
  await session.detach();
  const panel = await extension.browser.waitForTarget(target => target.url().endsWith('/sidepanel.html'));
  return panel.asPage();
}

export { sleep };
