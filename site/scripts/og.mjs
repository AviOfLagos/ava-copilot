// Link-preview images. After `astro build`, screenshots dist/og-card/<slug>.html at 1200×630 into dist/og/<slug>.png
// with a local Chromium-family browser (puppeteer-core, nothing downloaded, no network), then deletes the card
// templates from dist/ so they never deploy.
//
// No browser on this machine (a CI image, say)? The committed images in public/og/ ship as they are.
// `--update` also writes the new images to public/og/, to refresh that fallback.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const SLUGS = ['home', 'install', 'privacy'];
const site = fileURLToPath(new URL('..', import.meta.url));
const dist = join(site, 'dist');
const update = process.argv.includes('--update');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  join(homedir(), 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/brave-browser',
  '/usr/bin/microsoft-edge',
];

function removeTemplates() {
  rmSync(join(dist, 'og-card'), { recursive: true, force: true });
  for (const slug of SLUGS) rmSync(join(dist, `og-card-${slug}.html`), { force: true });
}

if (!existsSync(dist)) {
  console.error('og: dist/ is missing; run `astro build` first');
  process.exit(1);
}

if (!existsSync(join(dist, 'og-card'))) {
  console.warn(
    'og: no card templates in dist/ (already rendered by this build?); run `pnpm build` or `pnpm og:update`',
  );
  process.exit(0);
}

const executablePath = CANDIDATES.find(path => path && existsSync(path));
if (!executablePath) {
  console.warn('og: no Chromium-family browser found (set CHROME_PATH); shipping the images in public/og as they are');
  removeTemplates();
  process.exit(0);
}

let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.warn('og: puppeteer-core is not installed; shipping the images in public/og as they are');
  removeTemplates();
  process.exit(0);
}

const server = await serve(dist);
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb'],
});
let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  mkdirSync(join(dist, 'og'), { recursive: true });
  for (const slug of SLUGS) {
    const response = await page.goto(`${server.url}/og-card/${slug}`, { waitUntil: 'load' });
    if (!response || response.status() !== 200) throw new Error(`og-card/${slug} answered ${response?.status()}`);
    await page.evaluate(() => document.fonts.ready);
    await new Promise(done => setTimeout(done, 400));
    const out = join(dist, 'og', `${slug}.png`);
    await page.screenshot({ path: out, type: 'png' });
    if (update) {
      mkdirSync(join(site, 'public', 'og'), { recursive: true });
      copyFileSync(out, join(site, 'public', 'og', `${slug}.png`));
    }
    console.log(`og: ${slug}.png`);
  }
} catch (error) {
  failed = true;
  console.warn(`og: could not render the cards (${error.message}); shipping the images in public/og as they are`);
} finally {
  await browser.close();
  await server.close();
  removeTemplates();
}
process.exit(failed && !existsSync(join(dist, 'og', 'home.png')) ? 1 : 0);
