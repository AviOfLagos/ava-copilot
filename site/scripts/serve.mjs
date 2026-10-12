// A small static server for dist/, with the same URL rules as the host: /install serves install.html,
// unknown paths get 404.html with a 404 status. Used by og.mjs and verify.mjs; `astro preview` works too.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
};

// The host's response headers (vercel.json), so local checks see the same CSP and caching rules
function hostHeaders(root) {
  try {
    const config = JSON.parse(readFileSync(join(root, '..', 'vercel.json'), 'utf8'));
    return (config.headers ?? []).map(rule => ({
      pattern: new RegExp(`^${rule.source.replace('(.*)', '.*')}$`),
      headers: Object.fromEntries(rule.headers.map(header => [header.key, header.value])),
    }));
  } catch {
    return [];
  }
}

function resolveFile(root, pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const candidates = clean.endsWith('/')
    ? [join(clean, 'index.html')]
    : [clean, `${clean}.html`, join(clean, 'index.html')];
  for (const candidate of candidates) {
    const file = join(root, candidate);
    if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

/** Serves `root` on 127.0.0.1; resolves to { url, close }. */
export function serve(root, port = 0) {
  const rules = hostHeaders(root);
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    const file = resolveFile(root, pathname);
    const status = file ? 200 : 404;
    const body = file ?? join(root, '404.html');
    const extra = Object.assign({}, ...rules.filter(rule => rule.pattern.test(pathname)).map(rule => rule.headers));
    response.writeHead(status, { ...extra, 'Content-Type': TYPES[extname(body)] ?? 'application/octet-stream' });
    createReadStream(body).pipe(response);
  });
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise(done => server.close(done)) });
    });
  });
}

// `node scripts/serve.mjs [port]` serves dist/ until stopped
if (fileURLToPath(import.meta.url) === resolvePath(process.argv[1] ?? '')) {
  const root = fileURLToPath(new URL('../dist', import.meta.url));
  const { url } = await serve(root, Number(process.argv[2] ?? 4321));
  console.log(`Serving dist/ at ${url}`);
}
