#!/usr/bin/env node
// Fast-scroll stress test for the narrated tour: counts how many lines play at the same moment (must be 1).
// Run after `pnpm build`: node scripts/tour-overlap.mjs
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import puppeteer from 'puppeteer-core';
const root = path.resolve('dist');
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.m4a':'audio/mp4', '.svg':'image/svg+xml', '.webp':'image/webp', '.woff2':'font/woff2', '.png':'image/png', '.json':'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); let f = path.join(root, p === '/' ? 'index.html' : p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = fs.existsSync(f + '.html') ? f + '.html' : path.join(root, '404.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' }); res.end(fs.readFileSync(f));
}).listen(4411);
const browser = await puppeteer.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.evaluateOnNewDocument(() => {
  window.__max = 0; window.__samples = 0;
  setInterval(() => {
    const live = [...window.__els ?? []].filter(a => !a.paused && !a.ended && a.currentTime > 0).length;
    window.__samples++; if (live > window.__max) window.__max = live;
  }, 10);
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { (window.__els ??= new Set()).add(this); return orig.call(this); };
});
await page.goto('http://127.0.0.1:4411/', { waitUntil: 'load' });
await page.bringToFront();
await page.click('[data-tour-start]');
await new Promise(r => setTimeout(r, 2500));
const height = await page.evaluate(() => document.documentElement.scrollHeight);
for (let round = 0; round < 3; round++) {
  for (let y = 0; y < height; y += 260) { await page.evaluate(v => window.scrollTo(0, v), y); await new Promise(r => setTimeout(r, 90 + (y % 3) * 160)); }
  for (let y = height; y > 0; y -= 520) { await page.evaluate(v => window.scrollTo(0, v), y); await new Promise(r => setTimeout(r, 70)); }
}
await new Promise(r => setTimeout(r, 1500));
const result = await page.evaluate(() => ({ max: window.__max, samples: window.__samples, started: (window.__els ?? new Set()).size }));
console.log(JSON.stringify(result));
await browser.close(); server.close();
if (result.max > 1) { console.error('Lines overlapped:', result.max); process.exit(1); }
