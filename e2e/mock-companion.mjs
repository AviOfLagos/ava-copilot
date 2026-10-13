// A mock Nex Brain that speaks the real protocol (src/shared/lib/protocol/companion.ts, loaded by Node as
// TypeScript): pairing with a known code, health, sandbox runs that echo their command, and one artifact
// served through the real Avi Studio page and artifact CSP. It enforces what the real companion enforces
// (the extension's Origin, the bearer token) and records every request, so tests can check both.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import {
  ARTIFACT_HEADERS,
  COMPANION_EXTENSION_ORIGIN,
  COMPANION_PROTOCOL_VERSION,
  normalizePairingCode,
  pairRequestSchema,
  sandboxRunRequestSchema,
  STUDIO_SCRIPT,
  STUDIO_STYLE,
  studioCsp,
  studioPageHtml,
  studioSessionRequestSchema,
} from '../src/shared/lib/protocol/companion.ts';

const ARTIFACT_ID = 'a1b2c3d4e5f60718';
// A 1×1 PNG: the image an artifact may show, carried in the page itself
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const hash = text => createHash('sha256').update(text).digest('base64');

function artifactHtml(remoteUrl) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Remote image test</title>
<script>
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', event => {
    window.__violations.push(event.violatedDirective + ' ' + event.blockedURI);
  });
</script></head>
<body><h1 id="title">Made by an agent</h1>
<img id="local" alt="local" src="data:image/png;base64,${PIXEL}">
<img id="remote" alt="remote" src="${remoteUrl}">
<script>document.body.dataset.scripted = 'yes';</script>
</body></html>`;
}

export async function startMockCompanion({ code = 'ABCD-2345', docker = {} } = {}) {
  const requests = [];
  const sandboxRuns = [];
  const remoteHits = [];
  let token = null;
  const studioTokens = new Map();
  const viewKeys = new Set();

  // Another origin, standing in for the internet: an artifact must never reach it
  const remote = http.createServer((req, res) => {
    remoteHits.push(req.url);
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from(PIXEL, 'base64'));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const remoteUrl = `http://127.0.0.1:${remote.address().port}/pixel.png`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = req.headers.origin;
    requests.push({
      method: req.method,
      path: url.pathname,
      origin: origin ?? null,
      auth: req.headers.authorization ?? null,
    });
    let body = '';
    for await (const chunk of req) body += chunk;
    const send = (status, value, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...(origin === COMPANION_EXTENSION_ORIGIN ? { 'Access-Control-Allow-Origin': origin } : {}),
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    const fail = (status, kind, message) => send(status, { ok: false, error: { kind, message } });
    const self = `http://127.0.0.1:${server.address().port}`;

    if (req.method === 'OPTIONS') {
      if (origin !== COMPANION_EXTENSION_ORIGIN) return fail(403, 'forbidden', 'Not allowed.');
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Private-Network': 'true',
      });
      return res.end();
    }

    // Avi Studio: a tab, not the extension
    if (req.method === 'GET' && url.pathname === `/studio/${ARTIFACT_ID}`) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': studioCsp(hash(STUDIO_SCRIPT), hash(STUDIO_STYLE)),
      });
      return res.end(studioPageHtml({ id: ARTIFACT_ID, title: 'Remote image test', entry: 'index.html' }));
    }
    if (req.method === 'POST' && url.pathname === `/studio/${ARTIFACT_ID}/session`) {
      if (origin !== self) return fail(403, 'forbidden', 'Not allowed.');
      const parsed = studioSessionRequestSchema.safeParse(JSON.parse(body || '{}'));
      if (!parsed.success || !studioTokens.has(parsed.data.token))
        return fail(403, 'forbidden', 'This link has expired.');
      studioTokens.delete(parsed.data.token);
      const viewKey = randomBytes(32).toString('base64url');
      viewKeys.add(viewKey);
      return send(200, { ok: true, viewKey });
    }
    const view = /^\/view\/([^/]+)\/([^/]+)\/index\.html$/.exec(url.pathname);
    if (req.method === 'GET' && view) {
      if (view[1] !== ARTIFACT_ID || !viewKeys.has(view[2])) return fail(404, 'not_found', 'There is nothing here.');
      res.writeHead(200, { ...ARTIFACT_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(artifactHtml(remoteUrl));
    }

    if (!url.pathname.startsWith('/v1/')) return fail(404, 'not_found', 'There is nothing here.');
    // As the real companion: no GET in the API (the browser sends no Origin on an extension's GET)
    if (req.method === 'GET') return fail(404, 'not_found', 'There is nothing here.');
    if (origin !== COMPANION_EXTENSION_ORIGIN) return fail(403, 'forbidden', 'Only Nex Copilot may use Nex Brain.');

    if (req.method === 'POST' && url.pathname === '/v1/pair') {
      const parsed = pairRequestSchema.safeParse(JSON.parse(body || '{}'));
      if (!parsed.success || normalizePairingCode(parsed.data.code) !== code) {
        return fail(403, 'forbidden', 'That code is not right. Check it and try again.');
      }
      token = randomBytes(32).toString('base64url');
      return send(200, {
        ok: true,
        token,
        companionId: 'mock-mac',
        version: '0.1.0-mock',
        protocol: COMPANION_PROTOCOL_VERSION,
      });
    }
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      return fail(401, 'auth', 'Nex Brain does not know this browser. Pair again in Nex Copilot settings.');
    }

    if (req.method === 'POST' && url.pathname === '/v1/health') {
      return send(200, {
        ok: true,
        protocol: COMPANION_PROTOCOL_VERSION,
        version: '0.1.0-mock',
        companionId: 'mock-mac',
        uptimeMs: 1000,
        docker: { state: 'up', message: 'Docker is running.', version: '29.7.0', imageReady: true, ...docker },
        engine: { kind: 'eve', state: 'ready', message: null },
        mcp: [],
        workflows: { active: 0, running: 0 },
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/sandbox/run') {
      const parsed = sandboxRunRequestSchema.safeParse(JSON.parse(body || '{}'));
      if (!parsed.success) return fail(400, 'invalid', 'The request is not valid.');
      sandboxRuns.push(parsed.data);
      return send(200, {
        ok: true,
        exitCode: 0,
        stdout: `sandbox(${parsed.data.profileId}): ${parsed.data.command}\n`,
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 3,
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/artifacts/list') {
      return send(200, {
        ok: true,
        artifacts: [
          {
            id: ARTIFACT_ID,
            title: 'Remote image test',
            kind: 'html',
            entry: 'index.html',
            profileId: 'writer',
            files: 1,
            bytes: 600,
            createdAt: Date.now(),
          },
        ],
      });
    }
    if (req.method === 'POST' && url.pathname === `/v1/artifacts/${ARTIFACT_ID}/open`) {
      const studioToken = randomBytes(32).toString('base64url');
      studioTokens.set(studioToken, Date.now());
      return send(200, { ok: true, url: `${self}/studio/${ARTIFACT_ID}#${studioToken}` });
    }
    if (req.method === 'POST' && url.pathname === '/v1/unpair') {
      token = null;
      return send(200, { ok: true });
    }
    return fail(404, 'not_found', 'There is nothing here.');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    code,
    artifactId: ARTIFACT_ID,
    requests,
    sandboxRuns,
    remoteHits,
    token: () => token,
    async close() {
      server.closeAllConnections();
      remote.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => remote.close(resolve));
    },
  };
}
