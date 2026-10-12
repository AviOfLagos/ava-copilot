#!/usr/bin/env node
/**
 * The page's glass objects, rendered offline: three.js runs in headless Brave (never on the site), each object is
 * drawn twice — once lit, with a coloured light behind it that the glass refracts, and once as a plain silhouette —
 * and the two are combined into one image with a transparent background, saved as WebP in public/3d/.
 *
 *   node scripts/render-3d.mjs           # every object, both sizes
 *   node scripts/render-3d.mjs diamond   # just one
 *
 * Objects and colour jobs: the amber diamond is the commit point (waits for your click), the mint pill is the
 * composer, the periwinkle ring is voice. Needs a Chromium-family browser (CHROME_PATH) and the site's
 * devDependencies (three, puppeteer-core). Nothing is fetched from the network.
 */
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const site = fileURLToPath(new URL('..', import.meta.url));
const out = join(site, 'public', '3d');
const threeDir = join(site, 'node_modules', 'three');

// Each object at 720 px (shown at half its pixels); the ones that also sit inside a headline at 192 px (-sm)
const OBJECTS = {
  diamond: { color: '#f5b544', glow: '#ffb42e', inline: true },
  pill: { color: '#6ee7c8', glow: '#9ff3dc', inline: true },
  ring: { color: '#96a0ff', glow: '#c3c8ff', inline: false },
};
const SIZES = { '': 720, '-sm': 192 };
const only = process.argv.slice(2).filter(name => name in OBJECTS);
const names = only.length ? only : Object.keys(OBJECTS);

const BROWSERS = [
  process.env.CHROME_PATH,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  join(homedir(), 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];
const executablePath = BROWSERS.find(path => path && existsSync(path));
if (!executablePath) {
  console.error('render-3d: no Chromium-family browser found; set CHROME_PATH');
  process.exit(1);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>render</title>
<style>html,body{margin:0;background:transparent}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

function geometry(kind) {
  if (kind === 'diamond') {
    // The trail's amber diamond, in glass: a six-sided double point, so the outline stays a diamond and more facets
    // catch the light
    const top = new THREE.ConeGeometry(1.05, 1.45, 6, 1, true);
    top.translate(0, 0.725, 0);
    const bottom = new THREE.ConeGeometry(1.05, 1.45, 6, 1, true);
    bottom.rotateX(Math.PI);
    bottom.translate(0, -0.725, 0);
    const positions = [...top.toNonIndexed().attributes.position.array, ...bottom.toNonIndexed().attributes.position.array];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    return g;
  }
  if (kind === 'pill') return new THREE.CapsuleGeometry(0.6, 1.55, 24, 72);
  return new THREE.TorusGeometry(0.98, 0.33, 72, 180);
}

function pose(mesh, kind) {
  if (kind === 'diamond') mesh.rotation.set(0.32, 0.38, -0.14);
  if (kind === 'pill') mesh.rotation.set(0.35, 0.25, Math.PI / 2 - 0.42);
  if (kind === 'ring') mesh.rotation.set(1.02, -0.32, 0.18);
}

// Coloured light behind the object, in bands (light through fluted glass), on graphite: the glass refracts it,
// so each facet and curve catches a different part, bright or dark
function glowTexture(color) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#06070b';
  ctx.fillRect(0, 0, 1024, 1024);
  const core = ctx.createRadialGradient(470, 420, 0, 470, 420, 420);
  core.addColorStop(0, '#ffffff');
  core.addColorStop(0.12, color);
  core.addColorStop(0.5, color + '55');
  core.addColorStop(1, color + '00');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, 1024, 1024);
  // Bright and dark ribs across the light
  for (let x = 0; x < 1024; x += 44) {
    const rib = ctx.createLinearGradient(x, 0, x + 44, 0);
    rib.addColorStop(0, 'rgba(255,255,255,0.22)');
    rib.addColorStop(0.35, 'rgba(255,255,255,0)');
    rib.addColorStop(0.7, 'rgba(0,0,0,0.55)');
    rib.addColorStop(1, 'rgba(255,255,255,0.1)');
    ctx.fillStyle = rib;
    ctx.fillRect(x, 0, 44, 1024);
  }
  // A cool white streak, for a highlight that moves across the facets
  const streak = ctx.createLinearGradient(0, 0, 1024, 1024);
  streak.addColorStop(0.46, 'rgba(255,255,255,0)');
  streak.addColorStop(0.5, 'rgba(255,255,255,0.75)');
  streak.addColorStop(0.54, 'rgba(255,255,255,0)');
  ctx.fillStyle = streak;
  ctx.fillRect(0, 0, 1024, 1024);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

window.render = async ({ kind, size, color, glow }) => {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Khronos PBR Neutral keeps the brand hues (ACES pushes amber toward peach)
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0, 0, kind === 'pill' ? 7.4 : 6.6);

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-3, 4, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(new THREE.Color(glow), 3);
  rim.position.set(4, -2, -3);
  scene.add(rim);

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 9),
    new THREE.MeshBasicMaterial({ map: glowTexture(glow), toneMapped: false }),
  );
  backdrop.position.z = -2.4;
  scene.add(backdrop);

  // Clear glass with a light tint: the colour comes mostly from the light behind it
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#ffffff').lerp(new THREE.Color(color), kind === 'diamond' ? 0.62 : 0.35),
    side: kind === 'diamond' ? THREE.DoubleSide : THREE.FrontSide,
    metalness: 0,
    roughness: kind === 'diamond' ? 0.02 : 0.06,
    transmission: 1,
    thickness: kind === 'ring' ? 1.1 : 2.2,
    ior: kind === 'diamond' ? 2.1 : 1.55,
    attenuationColor: new THREE.Color(color),
    attenuationDistance: 3.2,
    dispersion: kind === 'diamond' ? 0.6 : 0.25,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    iridescence: kind === 'diamond' ? 0.3 : 0.15,
    iridescenceIOR: 1.3,
    specularIntensity: 1,
    envMapIntensity: 1.25,
    flatShading: kind === 'diamond',
  });
  const mesh = new THREE.Mesh(geometry(kind), material);
  pose(mesh, kind);
  scene.add(mesh);

  // Pass 1: the lit glass, with the light behind it
  renderer.render(scene, camera);
  const lit = document.createElement('canvas');
  lit.width = lit.height = size;
  lit.getContext('2d').drawImage(renderer.domElement, 0, 0);

  // Pass 2: the silhouette, for the transparency
  backdrop.visible = false;
  scene.environment = null;
  scene.remove(key, rim);
  mesh.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 1);
  renderer.render(scene, camera);
  const mask = document.createElement('canvas');
  mask.width = mask.height = size;
  const maskCtx = mask.getContext('2d');
  maskCtx.drawImage(renderer.domElement, 0, 0);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outCanvas.height = size;
  const ctx = outCanvas.getContext('2d');
  const image = lit.getContext('2d').getImageData(0, 0, size, size);
  const alpha = maskCtx.getImageData(0, 0, size, size).data;
  // Glass: bright parts solid, dark parts let the page show through
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const luma = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    const t = Math.min(1, Math.max(0, (luma - 0.04) / 0.5));
    const solid = 0.42 + 0.58 * t * t * (3 - 2 * t);
    data[i + 3] = Math.round(alpha[i] * solid);
  }
  ctx.putImageData(image, 0, 0);
  renderer.dispose();
  return outCanvas.toDataURL('image/webp', size > 300 ? 0.88 : 0.9);
};
window.ready = true;
</script>`;

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (pathname === '/') {
    response.writeHead(200, { 'Content-Type': TYPES['.html'] }).end(PAGE);
    return;
  }
  if (pathname.startsWith('/three/')) {
    const file = join(
      threeDir,
      normalize(decodeURIComponent(pathname.slice('/three'.length))).replace(/^(\.\.[/\\])+/, ''),
    );
    if (file.startsWith(threeDir) && existsSync(file) && statSync(file).isFile()) {
      response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(response);
      return;
    }
  }
  response.writeHead(404).end();
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error(`render-3d: page error: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') console.error(`render-3d: ${message.text()}`);
  });
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.ready === true, { timeout: 30_000 });
  mkdirSync(out, { recursive: true });
  for (const name of names) {
    for (const [suffix, size] of Object.entries(SIZES)) {
      if (suffix && !OBJECTS[name].inline) continue;
      const dataUrl = await page.evaluate(options => window.render(options), { kind: name, size, ...OBJECTS[name] });
      const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
      writeFileSync(join(out, `${name}${suffix}.webp`), bytes);
      console.log(`render-3d: ${name}${suffix}.webp  ${size}px  ${Math.round(bytes.length / 1024)} KB`);
    }
  }
} catch (error) {
  failed = true;
  console.error(`render-3d: ${error.message}`);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
