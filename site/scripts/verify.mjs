#!/usr/bin/env node
/**
 * The award-tier-ui verify sweep, on puppeteer-core with a local Chromium-family browser (no Playwright download).
 *
 *   node scripts/verify.mjs                       # builds nothing: serves dist/ and checks it
 *   SHOTS=/tmp/shots node scripts/verify.mjs      # where the screenshots go (default .verify/)
 *   BASE=http://localhost:4321 node scripts/verify.mjs   # check a running server instead
 *
 * Screenshots every route at 390, 768, 1280 and 1440 px in dark and light, plus reduced-motion and no-JavaScript
 * renders of the home page. Checks the stop-ship conditions a script can see: HTTP status, console and page errors,
 * horizontal overflow, one <h1>, a visible focus ring, metadata, running animations under reduced motion. Then it
 * drives the gate demo with a mouse, the keyboard and touch. Everything else needs eyes: read the screenshots.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { PredefinedNetworkConditions } from 'puppeteer-core';
import { serve } from './serve.mjs';

const ROUTES = ['/', '/install', '/privacy', '/no-such-page'];
const WIDTHS = [390, 768, 1280, 1440];
const THEMES = ['dark', 'light'];
const site = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.env.SHOTS ?? join(site, '.verify');
const BROWSERS = [
  process.env.CHROME_PATH,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];
const executablePath = BROWSERS.find(path => path && existsSync(path));
if (!executablePath) {
  console.error('verify: no Chromium-family browser found; set CHROME_PATH');
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const server = process.env.BASE ? null : await serve(join(site, 'dist'));
const base = process.env.BASE ?? server.url;
const findings = [];
const note = (route, context, message) => findings.push({ route, context, message });
const slug = route => (route === '/' ? 'home' : route.replace(/^\//, '').replace(/\//g, '-'));
const wait = ms => new Promise(done => setTimeout(done, ms));

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb'],
});

async function openPage(context, { width, height = 900, theme = 'dark', reduced = false, js = true, touch = false }) {
  const page = await browser.newPage();
  page.on('pageerror', error => note(page.url(), context, `pageerror: ${String(error).split('\n')[0]}`));
  page.on('console', message => {
    // The 404 route answers 404 on purpose; the browser logs that as an error
    if (message.type() !== 'error' || page.url().endsWith('/no-such-page')) return;
    note(page.url().replace(base, '') || '/', context, `console: ${message.text()}`);
  });
  page.on('requestfailed', request => note('(page)', context, `request failed: ${request.url()}`));
  page.on('request', request => {
    if (!request.url().startsWith(base) && !request.url().startsWith('data:')) {
      note('(page)', context, `third-party request: ${request.url()}`);
    }
  });
  await page.setJavaScriptEnabled(js);
  await page.setViewport({ width, height, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]);
  if (theme) {
    await page.evaluateOnNewDocument(choice => {
      try {
        localStorage.setItem('avi-theme', choice);
      } catch {
        // storage may be off
      }
    }, theme);
  }
  return page;
}

async function checkPage(page, route, context) {
  const report = await page.evaluate(() => {
    const focusable = document.querySelector('a[href], button:not([disabled])');
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      h1: document.querySelectorAll('h1').length,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      robots: document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null,
      ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null,
      lang: document.documentElement.lang,
      imagesWithoutAlt: [...document.querySelectorAll('img:not([alt])')].length,
      hasFocusable: !!focusable,
    };
  });
  if (report.overflow > 1) note(route, context, `horizontal overflow: ${report.overflow}px`);
  if (report.h1 !== 1) note(route, context, `${report.h1} <h1> elements`);
  if (!report.title) note(route, context, 'no <title>');
  if (!report.description && route !== '/no-such-page') note(route, context, 'no meta description');
  if (route === '/no-such-page') {
    if (report.robots !== 'noindex') note(route, context, '404 is not noindex');
  } else if (!report.canonical) note(route, context, 'no canonical');
  if (!report.ogImage) note(route, context, 'no og:image');
  if (report.lang !== 'en') note(route, context, `lang="${report.lang}"`);
  if (report.imagesWithoutAlt) note(route, context, `${report.imagesWithoutAlt} images without alt`);
  return report;
}

// 1. Routes × widths × themes
for (const theme of THEMES) {
  for (const width of WIDTHS) {
    const context = `${width}-${theme}`;
    const page = await openPage(context, { width, theme });
    for (const route of ROUTES) {
      const response = await page.goto(base + route, { waitUntil: 'load' });
      const expected = route === '/no-such-page' ? 404 : 200;
      if (!response || response.status() !== expected) note(route, context, `HTTP ${response?.status()}`);
      await page.evaluate(() => document.fonts.ready);
      await wait(route === '/' ? 5600 : 700);
      await checkPage(page, route, context);
      await page.screenshot({ path: join(OUT, `${slug(route)}-${context}.png`) });
      if (route !== '/no-such-page') {
        await page.screenshot({ path: join(OUT, `${slug(route)}-${context}-full.png`), fullPage: true });
      }
    }
    await page.close();
  }
}

// 2. Keyboard focus is visible: tab a few times on each page and read the outline
{
  const page = await openPage('focus', { width: 1280 });
  for (const route of ['/', '/install', '/privacy']) {
    await page.goto(base + route, { waitUntil: 'load' });
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          tag: el.tagName,
          text: (el.textContent ?? '').trim().slice(0, 30),
          outline: style.outlineStyle,
          width: style.outlineWidth,
        };
      });
      if (ring && (ring.outline === 'none' || ring.width === '0px'))
        note(route, 'focus', `no focus ring on ${ring.tag} "${ring.text}"`);
    }
    if (route === '/') {
      await page.keyboard.press('Tab');
      await page.screenshot({ path: join(OUT, `focus-home.png`) });
    }
  }
  await page.close();
}

// 3. Reduced motion: states shown at once, nothing left running
{
  const page = await openPage('reduced-motion', { width: 1440, reduced: true });
  for (const route of ['/', '/install', '/privacy']) {
    await page.goto(base + route, { waitUntil: 'load' });
    await wait(800);
    const running = await page.evaluate(
      () => document.getAnimations().filter(animation => animation.playState === 'running').length,
    );
    if (running > 0) note(route, 'reduced-motion', `${running} animation(s) still running`);
    if (route === '/') {
      const phase = await page.$eval('.gd', el => el.getAttribute('data-phase'));
      if (phase !== 'paused') note(route, 'reduced-motion', `demo is "${phase}", expected the paused state at once`);
    }
    await page.screenshot({ path: join(OUT, `reduced-motion-${slug(route)}.png`) });
  }
  await page.close();
}

// 4. No JavaScript: the home page reads, and the demo shows its paused state
{
  const page = await openPage('no-js', { width: 1440, js: false });
  await page.goto(base + '/', { waitUntil: 'load' });
  await wait(600);
  const state = await page.evaluate(() => ({
    phase: document.querySelector('.gd')?.getAttribute('data-phase'),
    card: !!document.querySelector('.gd [aria-labelledby="gd-card-title"]'),
    held: !!document.querySelector('.gd [data-status="held"]'),
    h1: document.querySelector('h1')?.textContent,
  }));
  if (state.phase !== 'paused' || !state.card || !state.held)
    note('/', 'no-js', `demo not paused: ${JSON.stringify(state)}`);
  await page.screenshot({ path: join(OUT, 'no-js-home.png') });
  await page.screenshot({ path: join(OUT, 'no-js-home-full.png'), fullPage: true });
  await page.close();
}

// 4b. The install tabs: /install#windows opens Windows, and the arrow keys move between tabs
{
  const page = await openPage('tabs', { width: 1280 });
  await page.goto(base + '/install#windows', { waitUntil: 'load' });
  await wait(400);
  const selected = await page.$eval('[role="tab"][aria-selected="true"]', el => el.dataset.os);
  if (selected !== 'windows') note('/install#windows', 'tabs', `selected "${selected}"`);
  const visible = await page.$$eval('[data-tab-panel]', panels =>
    panels.filter(p => getComputedStyle(p).display !== 'none').map(p => p.id),
  );
  if (visible.join() !== 'windows') note('/install#windows', 'tabs', `visible panels: ${visible.join()}`);
  await page.focus('[role="tab"][aria-selected="true"]');
  await page.keyboard.press('ArrowLeft');
  const after = await page.$eval('[role="tab"][aria-selected="true"]', el => el.dataset.os);
  if (after !== 'linux') note('/install', 'tabs', `ArrowLeft selected "${after}"`);
  await page.screenshot({ path: join(OUT, 'install-tabs-linux.png') });
  await page.close();
}

// 4c. The theme switch: Light applies and is remembered; System follows the OS
{
  const page = await openPage('theme', { width: 1280, theme: null });
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.click('[data-theme-toggle] [data-value="light"]');
  await page.reload({ waitUntil: 'load' });
  const light = await page.evaluate(() => document.documentElement.dataset.theme);
  if (light !== 'light') note('/', 'theme', `after choosing Light and reloading: ${light}`);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.click('[data-theme-toggle] [data-value="system"]');
  const system = await page.evaluate(() => document.documentElement.dataset.theme);
  if (system !== 'dark') note('/', 'theme', `System with a dark OS gave ${system}`);
  await page.close();
}

// 4d. Forced colours (Windows High Contrast): borders and focus survive; look at the picture
{
  const page = await openPage('forced-colors', { width: 1440 });
  // Puppeteer's own helper refuses forced-colors; the protocol takes it
  const session = await page.createCDPSession();
  await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  await page.goto(base + '/', { waitUntil: 'load' });
  await wait(6000);
  await page.screenshot({ path: join(OUT, 'forced-colors-home.png') });
  await page.close();
}

// 5. The gate demo, one fresh page per way of answering it: mouse hold, short press, two clicks, Space, Enter,
//    Stop, the composer's Stop during the run, and touch on a phone
const phaseOf = page => page.$eval('.gd', el => el.getAttribute('data-phase'));
async function waitPhase(page, phase, timeout = 9000) {
  await page.waitForFunction(
    value => {
      const el = document.querySelector('.gd');
      return !!el && el.hasAttribute('data-live') && el.getAttribute('data-phase') === value;
    },
    { timeout, polling: 100 },
    phase,
  );
}
async function holdButton(page) {
  const handle = await page.evaluateHandle(
    () =>
      [...document.querySelectorAll('.gd button')].find(button =>
        /Hold to send|Click again/.test(button.textContent ?? ''),
      ) ?? null,
  );
  const element = handle.asElement();
  if (!element) throw new Error('no Hold to send button');
  return element;
}
async function demoPage(context, options = {}) {
  const page = await openPage(context, { width: 1440, ...options });
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.evaluate(() => document.querySelector('.gd')?.scrollIntoView({ block: 'center' }));
  return page;
}
async function demoCase(name, options, steps) {
  const page = await demoPage(`demo:${name}`, options);
  try {
    await steps(page);
  } catch (error) {
    note(
      '/',
      `demo:${name}`,
      `failed: ${error.message.split('\n')[0]} (phase ${await phaseOf(page).catch(() => '?')})`,
    );
    await page.screenshot({ path: join(OUT, `demo-${name}-failure.png`) });
  }
  await page.close();
}

await demoCase('mouse', {}, async page => {
  await waitPhase(page, 'run', 4000);
  await page.screenshot({ path: join(OUT, 'demo-running.png') });
  await waitPhase(page, 'paused');
  await wait(400);
  await page.screenshot({ path: join(OUT, 'demo-paused.png') });
  const box = await (await holdButton(page)).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.down();
  await wait(400);
  await page.screenshot({ path: join(OUT, 'demo-holding.png') });
  await wait(600);
  await page.mouse.up();
  await waitPhase(page, 'sent', 2000);
  if (!(await page.$('.gd-sent'))) throw new Error('the page shows no sent reply');
  const focus = await page.evaluate(() => document.activeElement?.textContent?.trim());
  if (!/Run it again/.test(focus ?? '')) note('/', 'demo:mouse', `focus after the send went to "${focus}"`);
  await wait(400);
  await page.screenshot({ path: join(OUT, 'demo-sent.png') });
});

await demoCase('short-press-then-click', {}, async page => {
  await waitPhase(page, 'paused');
  const box = await (await holdButton(page)).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await wait(200);
  await page.mouse.up();
  await wait(500);
  if ((await phaseOf(page)) !== 'paused') throw new Error('a 200 ms press sent');
  await page.screenshot({ path: join(OUT, 'demo-armed.png') });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitPhase(page, 'sent', 2000);
});

for (const key of ['Space', 'Enter']) {
  await demoCase(`hold-${key.toLowerCase()}`, {}, async page => {
    await waitPhase(page, 'paused');
    await (await holdButton(page)).focus();
    await page.keyboard.down(key);
    await wait(1000);
    await page.keyboard.up(key);
    await waitPhase(page, 'sent', 2000);
  });
}

await demoCase('stop', {}, async page => {
  await waitPhase(page, 'paused');
  await page.evaluate(() =>
    [...document.querySelectorAll('.gd button')].find(b => b.textContent?.trim() === 'Stop')?.click(),
  );
  await waitPhase(page, 'stopped', 2000);
  if (await page.$('.gd-sent')) throw new Error('Stop still sent the reply');
  await wait(400);
  await page.screenshot({ path: join(OUT, 'demo-stopped.png') });
});

await demoCase('composer-stop', {}, async page => {
  await waitPhase(page, 'run', 4000);
  await wait(1500);
  await page.click('.gd form button[aria-label="Stop"]');
  await waitPhase(page, 'stopped', 2000);
  await wait(300);
  await page.screenshot({ path: join(OUT, 'demo-stopped-early.png') });
});

await demoCase('touch', { width: 390, height: 844, touch: true }, async page => {
  await waitPhase(page, 'paused');
  await wait(300);
  if (!(await page.$eval('.gd-page', el => getComputedStyle(el).display === 'none'))) {
    note('/', 'demo:touch', 'the mail page shows on a phone');
  }
  const button = await holdButton(page);
  await button.scrollIntoView();
  await wait(300);
  await page.screenshot({ path: join(OUT, 'demo-touch-paused.png') });
  const box = await button.boundingBox();
  await page.touchscreen.touchStart(box.x + box.width / 2, box.y + box.height / 2);
  await wait(1000);
  await page.touchscreen.touchEnd();
  await waitPhase(page, 'sent', 2000);
  await wait(300);
  await page.screenshot({ path: join(OUT, 'demo-touch-sent.png') });
});

// 6. Web vitals in the lab: layout shift through the whole demo run, and LCP on a throttled phone profile
const vitals = [];
for (const profile of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone, 4x CPU, Slow 4G', width: 390, height: 844, slow: true },
]) {
  const page = await openPage(`vitals:${profile.name}`, {
    width: profile.width,
    height: profile.height,
    touch: profile.slow,
  });
  await page.evaluateOnNewDocument(() => {
    window.__vitals = { cls: 0, lcp: 0 };
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__vitals.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver(list => {
      const entries = list.getEntries();
      window.__vitals.lcp = entries[entries.length - 1].startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  if (profile.slow) {
    await page.emulateCPUThrottling(4);
    await page.emulateNetworkConditions(PredefinedNetworkConditions['Slow 4G']);
  }
  await page.goto(base + '/', { waitUntil: 'load', timeout: 60000 });
  await wait(7000);
  const result = await page.evaluate(() => window.__vitals);
  vitals.push({ profile: profile.name, cls: Number(result.cls.toFixed(3)), lcp: Math.round(result.lcp) });
  if (result.cls > 0.1) note('/', `vitals:${profile.name}`, `CLS ${result.cls.toFixed(3)}`);
  if (result.lcp > 2500) note('/', `vitals:${profile.name}`, `LCP ${Math.round(result.lcp)} ms`);
  await page.close();
}

// 7. Discovery files and link previews
{
  const page = await browser.newPage();
  for (const path of [
    '/robots.txt',
    '/sitemap-index.xml',
    '/sitemap-0.xml',
    '/llms.txt',
    '/og/home.png',
    '/og/install.png',
    '/og/privacy.png',
    '/favicon.svg',
  ]) {
    const response = await page.goto(base + path);
    if (!response || response.status() !== 200) note(path, 'files', `HTTP ${response?.status()}`);
  }
  for (const path of ['/og-card/home']) {
    const response = await page.goto(base + path);
    if (response && response.status() === 200) note(path, 'files', 'OG card template was deployed');
  }
  await page.close();
}

await browser.close();
await server?.close();

console.log('Lab vitals (home):');
for (const row of vitals) console.log(`  ${row.profile.padEnd(24)} CLS ${row.cls}   LCP ${row.lcp} ms`);
console.log('');
if (findings.length === 0) console.log('No automated stop-ship conditions triggered.');
else {
  console.log('Findings:\n');
  for (const finding of findings)
    console.log(`  ${finding.context.padEnd(16)} ${finding.route.padEnd(18)} ${finding.message}`);
}
console.log(`\nScreenshots in ${OUT} — now read them.`);
process.exit(findings.length ? 1 : 0);
