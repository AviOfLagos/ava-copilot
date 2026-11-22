#!/usr/bin/env node
/**
 * The award-tier-ui verify sweep, on puppeteer-core with a local Chromium-family browser (no Playwright download).
 *
 *   node scripts/verify.mjs                       # builds nothing: serves dist/ and checks it
 *   SHOTS=/tmp/shots node scripts/verify.mjs      # where the screenshots go (default .verify/)
 *   BASE=http://localhost:4321 node scripts/verify.mjs   # check a running server instead
 *
 * Screenshots every route at 390, 768, 1280 and 1440 px in dark and light, every home section at 1440 and 390 in
 * both themes with the globe in its spot, the tour playing, and reduced-motion, no-JavaScript and forced-colours
 * renders. Checks the stop-ship conditions a script can see: HTTP status, console and page errors, requests to other
 * origins, horizontal overflow, one <h1>, a visible focus ring, metadata, running animations under reduced motion.
 * Then it drives the globe (it follows the sections and never covers a headline), Ava's tour (nothing loads before
 * the click; one line at a time; captions follow the sections; pause, a hidden tab, Esc and Stop), the widgets and
 * the gate demo (mouse, keyboard, touch), and measures the initial JavaScript and lab vitals. Everything else needs
 * eyes: read the screenshots.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import puppeteer, { PredefinedNetworkConditions } from 'puppeteer-core';
import { serve } from './serve.mjs';

const ROUTES = ['/', '/install', '/privacy', '/features', '/features/gate', '/features/ambient', '/features/meetings', '/features/workspaces', '/features/brain', '/features/trust', '/features/browser', '/features/automation', '/features/tasks', '/features/whatsapp', '/features/team', '/roadmap', '/changelog', '/contribute', '/donate', '/no-such-page'];
const WIDTHS = [390, 768, 1280, 1440];
const THEMES = ['dark', 'light'];
// The home page's parts, in order: [id, globe spot expected on wide screens]
const SECTIONS = [
  ['gate', 'peek'],
  ['steps', 'left'],
  ['voice', 'right'],
  ['memory', 'left'],
  ['routines', 'right'],
  ['models', 'left'],
  ['integrations', 'right'],
  ['privacy-label', 'left'],
  ['tasks', 'away'],
  ['faq', 'right'],
  ['install-now', 'low'],
];
const JS_BUDGET_GZ = 92 * 1024;
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
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    // As a visitor's browser: sound only after a click
    '--autoplay-policy=user-gesture-required',
  ],
});

async function openPage(context, { width, height = 900, theme = 'dark', reduced = false, js = true, touch = false }) {
  const page = await browser.newPage();
  page.on('pageerror', error => note(page.url(), context, `pageerror: ${String(error).split('\n')[0]}`));
  page.on('console', message => {
    // The 404 route answers 404 on purpose; the browser logs that as an error
    if (message.type() !== 'error' || page.url().endsWith('/no-such-page')) return;
    note(page.url().replace(base, '') || '/', context, `console: ${message.text()}`);
  });
  page.on('requestfailed', request => {
    // A recording cut short by the next section is aborted on purpose
    if (request.url().includes('/audio/') && /ABORTED/.test(request.failure()?.errorText ?? '')) return;
    note('(page)', context, `request failed: ${request.url()}`);
  });
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

/** Scrolls so a section's head sits a little below the middle, as a reader arrives at it, and lets the globe glide. */
async function arrive(page, id, settle = 1700) {
  await page.evaluate(target => {
    const section = document.getElementById(target);
    if (!section) return;
    const head = section.querySelector('.sec__head, h2') ?? section;
    const top = head.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, top - window.innerHeight * 0.32), behavior: 'instant' });
  }, id);
  await wait(settle);
}

/** Where the globe's sphere is and whether it covers the active section's headline or sentence. */
function globeReport(page, id) {
  return page.evaluate(target => {
    const root = document.querySelector('[data-globe-root]');
    const body = document.querySelector('[data-globe-body]');
    if (!root || !body) return null;
    const box = body.getBoundingClientRect();
    const opacity = Number(getComputedStyle(body).opacity);
    // The sphere fills about 86% of the canvas
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const r = (box.width / 2) * 0.86;
    const section = document.getElementById(target);
    const parts = section ? [...section.querySelectorAll('.headline, .sec__body')] : [];
    const covered = parts.some(part => {
      for (const rect of part.getClientRects()) {
        // Distance from the sphere's centre to the nearest point of the line box
        const nx = Math.max(rect.left, Math.min(cx, rect.right));
        const ny = Math.max(rect.top, Math.min(cy, rect.bottom));
        if (Math.hypot(nx - cx, ny - cy) < r * 0.92 && opacity > 0.1) return true;
      }
      return false;
    });
    return {
      follow: root.hasAttribute('data-follow'),
      live: root.hasAttribute('data-live'),
      x: Math.round(cx),
      y: Math.round(cy),
      r: Math.round(r),
      opacity,
      covered,
      state: section?.dataset.state ?? null,
    };
  }, id);
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
      await wait(route === '/' ? 1600 : 700);
      await checkPage(page, route, context);
      await page.screenshot({ path: join(OUT, `${slug(route)}-${context}.png`) });
      if (route !== '/no-such-page' && route !== '/') {
        await page.screenshot({ path: join(OUT, `${slug(route)}-${context}-full.png`), fullPage: true });
      }
    }
    await page.close();
  }
}

// 2. The home page, part by part, at 1440 and 390 in both themes: the globe in its spot beside each headline
const spots = {};
for (const theme of THEMES) {
  for (const width of [1440, 390]) {
    const context = `sections-${width}-${theme}`;
    const page = await openPage(context, { width, height: width < 600 ? 844 : 900, theme, touch: width < 600 });
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await wait(900);
    const hero = await globeReport(page, 'gate');
    if (width >= 900 && !hero?.follow) note('/', context, 'the globe does not follow the page on a wide screen');
    if (width < 900 && hero?.follow) note('/', context, 'the globe follows the page on a phone');
    if (!hero?.live) note('/', context, 'the globe never started drawing');
    for (const [id, spot] of SECTIONS) {
      await arrive(page, id);
      const report = await globeReport(page, id);
      if (width >= 900 && theme === 'dark') spots[id] = { ...report, spot };
      if (width >= 900 && report?.covered) note('/', context, `the globe covers the headline of #${id}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) note('/', context, `horizontal overflow at #${id}: ${overflow}px`);
      await page.screenshot({ path: join(OUT, `home-${id}-${width}-${theme}.png`) });
    }
    await page.close();
  }
}
// The globe really moves: left and right spots sit on different sides, and the dark list sends it away
{
  const xs = SECTIONS.filter(([, spot]) => spot === 'left' || spot === 'right').map(([id, spot]) => [
    spot,
    spots[id]?.x,
  ]);
  const lefts = xs.filter(([spot]) => spot === 'left').map(([, x]) => x);
  const rights = xs.filter(([spot]) => spot === 'right').map(([, x]) => x);
  if (lefts.length && rights.length && Math.max(...lefts) >= Math.min(...rights))
    note('/', 'globe', `left and right spots overlap (left ≤ ${Math.max(...lefts)}, right ≥ ${Math.min(...rights)})`);
  if ((spots.tasks?.opacity ?? 0) > 0.1) note('/', 'globe', 'the globe stays visible over the dark task list');
}

// 3. Ava's tour: nothing before the click; one line at a time; captions follow; pause, hidden tab, Esc, Stop
async function tourState(page) {
  return page.evaluate(() => {
    const dock = document.querySelector('[data-tour-dock]');
    return {
      phase: dock?.dataset.phase,
      hidden: dock?.hidden,
      caption: document.querySelector('[data-tour-caption]')?.textContent ?? '',
      label: document.querySelector('[data-tour-label]')?.textContent ?? '',
      playing: (window.__media ?? []).filter(media => !media.paused).map(media => media.src.split('/').pop()),
      level: Number(getComputedStyle(dock).getPropertyValue('--level') || 0),
      speaking: [...document.querySelectorAll('[data-speaking]')].map(section => section.dataset.say),
    };
  });
}
for (const width of [1440, 390]) {
  const context = `tour-${width}`;
  const page = await openPage(context, { width, height: width < 600 ? 844 : 900, touch: width < 600 });
  const audio = [];
  page.on('request', request => request.url().includes('/audio/') && audio.push(request.url().split('/').pop()));
  await page.evaluateOnNewDocument(() => {
    window.__media = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!window.__media.includes(this)) window.__media.push(this);
      return play.call(this);
    };
  });
  try {
    await page.goto(base + '/', { waitUntil: 'load' });
    await wait(1800);
    await arrive(page, 'gate', 800);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await wait(600);
    if (audio.length) note('/', context, `audio requested before the click: ${audio.join(', ')}`);
    if ((await tourState(page)).playing.length) note('/', context, 'something plays before the click');
    const lines = await page.evaluate(() => JSON.parse(document.getElementById('tour-data').textContent).lines);
    const byId = Object.fromEntries(lines.map(line => [line.id, line]));
    // The transcript holds every line, with JavaScript or without
    const transcript = await page.$eval('#transcript', el => el.textContent ?? '');
    for (const line of lines)
      if (!transcript.includes(line.text.slice(0, 40))) note('/', context, `the transcript lacks the ${line.id} line`);

    await page.click('[data-tour-start]');
    await wait(1400);
    let state = await tourState(page);
    if (state.hidden || state.phase !== 'playing') note('/', context, `after the click the tour is "${state.phase}"`);
    if (state.playing.length !== 1 || !state.playing[0]?.startsWith('hero-'))
      note('/', context, `after the click it plays ${JSON.stringify(state.playing)}, expected the hero line`);
    if (!state.caption.startsWith(byId.hero.text.slice(0, 30))) note('/', context, 'the caption is not the hero line');
    if (width >= 900 && state.level <= 0) note('/', context, 'the level meter stays at 0 while it speaks');
    await page.screenshot({ path: join(OUT, `tour-hero-${width}.png`) });

    for (const [id, say] of [
      ['gate', 'gate'],
      ['steps', 'steps'],
      ['voice', 'voice'],
    ]) {
      await arrive(page, id, 1500);
      state = await tourState(page);
      if (state.playing.length !== 1 || !state.playing[0]?.startsWith(`${say}-`))
        note('/', context, `at #${id} it plays ${JSON.stringify(state.playing)}, expected only the ${say} line`);
      if (!state.caption.startsWith(byId[say].text.slice(0, 30)))
        note('/', context, `the caption at #${id} is not its line`);
      if (!state.speaking.includes(say)) note('/', context, `#${id} is not marked as speaking`);
    }
    await page.screenshot({ path: join(OUT, `tour-voice-${width}.png`) });

    await page.click('[data-tour-pause]');
    await wait(400);
    state = await tourState(page);
    if (state.phase !== 'paused' || state.playing.length)
      note('/', context, `Pause left it "${state.phase}", playing ${state.playing}`);
    await page.click('[data-tour-pause]');
    await wait(700);
    state = await tourState(page);
    if (state.phase !== 'playing' || state.playing.length !== 1) note('/', context, `Resume left it "${state.phase}"`);

    // A hidden tab pauses it; coming back resumes it
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await wait(300);
    state = await tourState(page);
    if (state.playing.length || state.phase !== 'paused') note('/', context, 'a hidden tab did not pause the tour');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await wait(600);
    state = await tourState(page);
    if (state.phase !== 'playing') note('/', context, 'returning to the tab did not resume the tour');

    // Esc stops it
    await page.keyboard.press('Escape');
    await wait(400);
    state = await tourState(page);
    if (!state.hidden || state.playing.length) note('/', context, 'Esc did not stop the tour');

    // Start again, and Stop with the button, by keyboard
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await wait(500);
    await page.focus('[data-tour-start]');
    await page.keyboard.press('Enter');
    await wait(1000);
    state = await tourState(page);
    if (state.phase !== 'playing') note('/', context, 'Enter on "Listen to the tour" did not start it');
    await page.focus('[data-tour-stop]');
    await page.keyboard.press('Enter');
    await wait(400);
    state = await tourState(page);
    if (!state.hidden || state.playing.length) note('/', context, 'Stop did not stop the tour');
  } catch (error) {
    note('/', context, `failed: ${error.message.split('\n')[0]}`);
    await page.screenshot({ path: join(OUT, `tour-failure-${width}.png`) });
  }
  await page.close();
}

// 4. The widgets: the run hands the page back and waits at Submit; the graph lights; the routine waits; the Inbox
//    takes an answer; the model picker tells where the words go
{
  const context = 'widgets';
  const page = await openPage(context, { width: 1440 });
  try {
    // The widgets animate only while they are seen: a page in the background would stall them
    await page.bringToFront();
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.evaluate(() => document.querySelector('[data-trail-run]').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForFunction(() => document.querySelector('[data-trail-run]')?.dataset.state === 'handback', {
      timeout: 6000,
      polling: 100,
    });
    await page.screenshot({ path: join(OUT, 'widget-trail-handback.png') });
    await page.click('[data-trail-run] [data-continue]');
    await page.waitForFunction(() => document.querySelector('[data-trail-run]')?.dataset.state === 'held', {
      timeout: 8000,
      polling: 100,
    });
    await wait(300);
    await page.screenshot({ path: join(OUT, 'widget-trail-held.png') });
    await page.click('[data-trail-run] [data-replay]');
    await wait(1600);
    await page.click('[data-trail-run] .tr-stop');
    const stopped = await page.$eval('[data-trail-run]', el => el.dataset.state);
    if (stopped !== 'stopped') note('/', context, `Stop left the run "${stopped}"`);

    await page.evaluate(() => document.querySelector('[data-graph]').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await wait(400);
    const node = await page.$('[data-graph] [data-node="meeting"]');
    const box = await node.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
    await wait(300);
    const focus = await page.$eval('[data-graph] svg', el => el.getAttribute('data-focus'));
    if (focus !== 'meeting') note('/', context, `pointing at a node lit "${focus}"`);
    const detail = await page.$eval('[data-graph-detail]', el => el.textContent ?? '');
    if (!/Mon call/.test(detail)) note('/', context, `the graph caption says "${detail}"`);
    await page.screenshot({ path: join(OUT, 'widget-graph-hover.png') });

    await page.evaluate(() => document.querySelector('[data-routine]').scrollIntoView({ block: 'center', behavior: 'instant' }));
    // The post step's own status, not only the diagram's: the two are set a moment apart
    await page
      .waitForFunction(() => document.querySelector('[data-routine] [data-held]')?.dataset.status === 'waiting', {
        timeout: 20000,
        polling: 100,
      })
      .catch(() => {});
    const held = await page.$eval('[data-routine] [data-held]', el => el.dataset.status);
    if (held !== 'waiting') note('/', context, `the routine's post step is "${held}"`);
    await page.click('[data-inbox] [data-card] [data-answer="approve"]');
    await wait(500);
    const inbox = await page.evaluate(() => ({
      gone: document.querySelectorAll('[data-inbox] [data-gone]').length,
      result: document.querySelector('[data-inbox] [data-result]')?.textContent ?? '',
    }));
    if (inbox.gone !== 1 || !inbox.result) note('/', context, `the Inbox after Approve: ${JSON.stringify(inbox)}`);
    await page.screenshot({ path: join(OUT, 'widget-routine-inbox.png') });

    await page.evaluate(() => document.querySelector('[data-models]').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.click('[data-models] input[value="anthropic"]');
    await wait(200);
    const route = await page.evaluate(() => ({
      kind: document.querySelector('[data-route]')?.dataset.kind,
      host: document.querySelector('[data-route] [data-fill="host"]')?.textContent,
    }));
    if (route.kind !== 'cloud' || route.host !== 'api.anthropic.com')
      note('/', context, `the route says ${JSON.stringify(route)}`);
    await page.screenshot({ path: join(OUT, 'widget-models-cloud.png') });

    await page.evaluate(() => document.querySelector('[data-tasks]').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await wait(300);
    const row = await (await page.$('[data-task="1"]')).boundingBox();
    await page.mouse.move(row.x + row.width * 0.4, row.y + row.height / 2, { steps: 12 });
    await wait(500);
    const previewing = await page.$eval('[data-tasks]', el => el.hasAttribute('data-previewing'));
    if (!previewing) note('/', context, 'pointing at a task shows no preview');
    await page.screenshot({ path: join(OUT, 'widget-task-preview.png') });
  } catch (error) {
    note('/', context, `failed: ${error.message.split('\n')[0]}`);
    await page.screenshot({ path: join(OUT, 'widgets-failure.png') });
  }
  await page.close();
}

// 5. Keyboard focus is visible: tab a few times on each page and read the outline
{
  const page = await openPage('focus', { width: 1280 });
  for (const route of ['/', '/install', '/privacy']) {
    await page.goto(base + route, { waitUntil: 'load' });
    for (let i = 0; i < 8; i++) {
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
    if (route === '/') await page.screenshot({ path: join(OUT, `focus-home.png`) });
  }
  await page.close();
}

// 6. Reduced motion: states shown at once, nothing left running, the globe still in the hero, the tour still speaks
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
      const globe = await page.$eval('[data-globe-root]', el => ({
        follow: el.hasAttribute('data-follow'),
        live: el.hasAttribute('data-live'),
      }));
      if (globe.follow || globe.live)
        note(route, 'reduced-motion', `the globe moves or draws: ${JSON.stringify(globe)}`);
      const trail = await page.$eval('[data-trail-run]', el => el.dataset.state);
      if (trail !== 'held') note(route, 'reduced-motion', `the run is "${trail}", expected the whole run at once`);
      await page.click('[data-tour-start]');
      await wait(900);
      const playing = await page.$eval('[data-tour-dock]', el => el.dataset.phase);
      if (playing !== 'playing') note(route, 'reduced-motion', `the tour is "${playing}" after the click`);
      await page.keyboard.press('Escape');
    }
    await page.screenshot({ path: join(OUT, `reduced-motion-${slug(route)}.png`) });
  }
  await page.close();
}

// 7. No JavaScript: the home page reads; the demo, the run and the globe show their still states; the tour's words
{
  const page = await openPage('no-js', { width: 1440, js: false });
  await page.goto(base + '/', { waitUntil: 'load' });
  await wait(600);
  const state = await page.evaluate(() => ({
    phase: document.querySelector('.gd')?.getAttribute('data-phase'),
    card: !!document.querySelector('.gd [aria-labelledby="gd-card-title"]'),
    held: !!document.querySelector('.gd [data-status="held"]'),
    h1: document.querySelector('h1')?.textContent,
    globe: getComputedStyle(document.querySelector('.globe__still')).visibility,
    trail: document.querySelectorAll('[data-trail-run] [data-on]').length,
    transcript: document.querySelectorAll('#transcript li').length,
  }));
  if (state.phase !== 'paused' || !state.card || !state.held)
    note('/', 'no-js', `demo not paused: ${JSON.stringify(state)}`);
  if (state.globe !== 'visible') note('/', 'no-js', 'the globe’s still frame is hidden');
  if (state.trail < 5) note('/', 'no-js', `the run shows ${state.trail} steps`);
  if (state.transcript < 10) note('/', 'no-js', `the transcript has ${state.transcript} lines`);
  await page.screenshot({ path: join(OUT, 'no-js-home.png') });
  await page.screenshot({ path: join(OUT, 'no-js-home-full.png'), fullPage: true });
  await page.close();
}

// 7b. The install tabs: /install#windows opens Windows, and the arrow keys move between tabs
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

// 7c. The theme switch: Light applies and is remembered; System follows the OS
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

// 7d. Forced colours (Windows High Contrast): borders and focus survive; look at the picture
{
  const page = await openPage('forced-colors', { width: 1440 });
  // Puppeteer's own helper refuses forced-colors; the protocol takes it
  const session = await page.createCDPSession();
  await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  await page.goto(base + '/', { waitUntil: 'load' });
  await wait(1500);
  await page.screenshot({ path: join(OUT, 'forced-colors-home.png') });
  await arrive(page, 'routines', 800);
  await page.screenshot({ path: join(OUT, 'forced-colors-routines.png') });
  await page.close();
}

// 8. The gate demo, one fresh page per way of answering it: mouse hold, short press, two clicks, Space, Enter,
//    Stop, the composer's Stop during the run, and touch on a phone
const phaseOf = page => page.$eval('.gd', el => el.getAttribute('data-phase'));
async function waitPhase(page, phase, timeout = 20000) {
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
  // A page in the background gets throttled timers and no animation frames: the demo would run late
  await page.bringToFront();
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.evaluate(() => document.querySelector('.gd')?.scrollIntoView({ block: 'center', behavior: 'instant' }));
  // On a busy machine the first intersection report can come late: a small scroll asks for a fresh one
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = await page
      .waitForFunction(() => document.querySelector('.gd')?.hasAttribute('data-live'), { timeout: 4000, polling: 100 })
      .then(() => true)
      .catch(() => false);
    if (started) break;
    await page.evaluate(step => window.scrollBy(0, step), attempt % 2 ? -3 : 3);
  }
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

// 9. Web vitals in the lab (layout shift and LCP, desktop and a throttled phone) and the JavaScript a first visit
//    loads before it scrolls
const vitals = [];
let initialJs = 0;
for (const profile of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone, 4x CPU, Slow 4G', width: 390, height: 844, slow: true },
]) {
  const page = await openPage(`vitals:${profile.name}`, {
    width: profile.width,
    height: profile.height,
    touch: profile.slow,
  });
  const scripts = new Set();
  page.on('request', request => {
    if (request.resourceType() === 'script' && request.url().startsWith(base))
      scripts.add(new URL(request.url()).pathname);
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
  if (!profile.slow && !process.env.BASE) {
    for (const path of scripts) {
      const file = join(site, 'dist', path);
      if (existsSync(file)) initialJs += gzipSync(readFileSync(file)).length;
    }
    if (initialJs > JS_BUDGET_GZ) note('/', 'budget', `initial JavaScript ${(initialJs / 1024).toFixed(1)} KB gzipped`);
  }
  await page.close();
}

// 10. Discovery files and link previews
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
if (initialJs) console.log(`Initial JavaScript (home, before scrolling): ${(initialJs / 1024).toFixed(1)} KB gzipped`);
console.log('Globe spots (1440, dark):');
for (const [id, spot] of SECTIONS) {
  const report = spots[id];
  if (report)
    console.log(
      `  #${id.padEnd(14)} ${spot.padEnd(5)} centre ${String(report.x).padStart(5)},${String(report.y).padStart(4)}  r ${report.r}  ${report.state ?? ''}${report.opacity < 0.1 ? '  (away)' : ''}`,
    );
}
console.log('');
if (findings.length === 0) console.log('No automated stop-ship conditions triggered.');
else {
  console.log('Findings:\n');
  for (const finding of findings)
    console.log(`  ${finding.context.padEnd(16)} ${finding.route.padEnd(18)} ${finding.message}`);
}
console.log(`\nScreenshots in ${OUT} — now read them.`);
process.exit(findings.length ? 1 : 0);
