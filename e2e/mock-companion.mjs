// A mock Nex Brain that speaks the real protocol (src/shared/lib/protocol/companion.ts, loaded by Node as
// TypeScript): pairing with a known code, health, sandbox runs that echo their command, and one artifact
// served through the real Avi Studio page and artifact CSP. It enforces what the real companion enforces
// (the extension's Origin, the bearer token) and records every request, so tests can check both.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import {
  ARTIFACT_HEADERS,
  BACKUP_CHUNK_BYTES,
  BACKUP_ROUTES,
  backupBeginRequestSchema,
  CALENDAR_ROUTES,
  calendarEventsRequestSchema,
  isSafeNotePath,
  OBSIDIAN_ROUTES,
  obsidianChooseRequestSchema,
  obsidianWriteRequestSchema,
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

// A vault and a Mac Calendar in memory: nothing on the machine running the tests is read
export const MOCK_VAULT = { id: 'f00df00df00df00d', name: 'E2E Vault', path: '/Users/e2e/E2E Vault' };

export async function startMockCompanion({ code = 'ABCD-2345', docker = {}, calendarAccess = 'not_determined' } = {}) {
  // path → { text, mtime }
  const vaultNotes = new Map([
    ['Projects/Blue folder.md', { text: '# Blue folder\nThe blue folder holds the tower drawings.', mtime: 1000 }],
  ]);
  let chosenVault = null;
  const calendar = {
    access: calendarAccess,
    calendars: [
      { id: 'cal-work', title: 'Work', account: 'avi@nexprove.com', color: null },
      { id: 'cal-home', title: 'Home', account: 'iCloud', color: null },
    ],
    events: [],
    eventRequests: [],
  };
  const requests = [];
  const sandboxRuns = [];
  const remoteHits = [];
  let token = null;
  const studioTokens = new Map();
  const viewKeys = new Set();
  const backups = new Map();
  const uploads = new Map();
  let backupSecrets = null;

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
    // Backups, kept in memory for as long as the mock runs: a second browser (a reinstall) finds them
    const json = () => JSON.parse(body || '{}');
    if (req.method === 'POST' && url.pathname === BACKUP_ROUTES.list) {
      return send(200, {
        ok: true,
        snapshots: [...backups.values()].map(entry => entry.meta).sort((a, b) => b.createdAt - a.createdAt),
        secrets: { storedAt: backupSecrets ? 1 : null, count: Object.keys(backupSecrets ?? {}).length },
      });
    }
    if (req.method === 'POST' && url.pathname === BACKUP_ROUTES.begin) {
      const parsed = backupBeginRequestSchema.safeParse(json());
      if (!parsed.success) return fail(400, 'invalid', 'The backup request is not valid.');
      const uploadId = randomBytes(16).toString('hex');
      const { requestId: _requestId, ...meta } = parsed.data;
      uploads.set(uploadId, { meta, parts: [] });
      return send(200, { ok: true, uploadId, chunkBytes: BACKUP_CHUNK_BYTES });
    }
    const chunk = /^\/v1\/backups\/uploads\/([a-f0-9]{32})\/chunks\/(\d+)$/.exec(url.pathname);
    if (req.method === 'PUT' && chunk) {
      const upload = uploads.get(chunk[1]);
      if (!upload || Number(chunk[2]) !== upload.parts.length) return fail(400, 'invalid', 'Out of order.');
      upload.parts.push(Buffer.from(json().data, 'base64'));
      return send(200, { ok: true });
    }
    const commit = /^\/v1\/backups\/uploads\/([a-f0-9]{32})\/commit$/.exec(url.pathname);
    if (req.method === 'POST' && commit) {
      const upload = uploads.get(commit[1]);
      uploads.delete(commit[1]);
      const bytes = Buffer.concat(upload?.parts ?? []);
      if (!upload || createHash('sha256').update(bytes).digest('hex') !== upload.meta.sha256) {
        return fail(400, 'invalid', 'The backup arrived damaged.');
      }
      const meta = { ...upload.meta, id: `${upload.meta.createdAt}-${randomBytes(4).toString('hex')}` };
      backups.set(meta.id, { meta, bytes });
      return send(200, { ok: true, snapshot: meta });
    }
    const read = /^\/v1\/backups\/(\d{13}-[a-f0-9]{8})\/read$/.exec(url.pathname);
    if (req.method === 'POST' && read) {
      const entry = backups.get(read[1]);
      if (!entry) return fail(404, 'not_found', 'That backup is not on this Mac any more.');
      const index = json().index ?? 0;
      const chunks = Math.max(1, Math.ceil(entry.bytes.length / BACKUP_CHUNK_BYTES));
      const data = entry.bytes.subarray(index * BACKUP_CHUNK_BYTES, (index + 1) * BACKUP_CHUNK_BYTES);
      return send(200, { ok: true, index, chunks, data: data.toString('base64') });
    }
    if (req.method === 'POST' && url.pathname === BACKUP_ROUTES.secretsPut) {
      backupSecrets = json().secrets;
      return send(200, { ok: true, storedAt: 1, count: Object.keys(backupSecrets).length });
    }
    if (req.method === 'POST' && url.pathname === BACKUP_ROUTES.secretsGet) {
      return send(200, { ok: true, secrets: backupSecrets ?? {}, storedAt: backupSecrets ? 1 : null });
    }
    if (req.method === 'DELETE' && url.pathname === BACKUP_ROUTES.secretsClear) {
      backupSecrets = null;
      return send(200, { ok: true });
    }
    // Obsidian through Nex Brain, as the real one answers (a vault in memory)
    if (req.method === 'POST' && url.pathname === OBSIDIAN_ROUTES.vaults) {
      const listed = { ...MOCK_VAULT, found: 'obsidian', usable: true };
      return send(200, { ok: true, vaults: [listed], chosen: chosenVault ? listed : null });
    }
    if (req.method === 'POST' && url.pathname === OBSIDIAN_ROUTES.choose) {
      const parsed = obsidianChooseRequestSchema.safeParse(json());
      if (!parsed.success || parsed.data.path !== MOCK_VAULT.path) {
        return fail(400, 'invalid', 'That folder is not an Obsidian vault (it has no .obsidian folder).');
      }
      chosenVault = MOCK_VAULT.id;
      return send(200, { ok: true, vault: { ...MOCK_VAULT, found: 'obsidian', usable: true } });
    }
    if (req.method === 'POST' && url.pathname === OBSIDIAN_ROUTES.forget) {
      chosenVault = null;
      return send(200, { ok: true });
    }
    if (url.pathname.startsWith('/v1/obsidian/') && json().vaultId !== chosenVault) {
      return fail(404, 'not_found', 'No Obsidian vault is chosen in Nex Brain.');
    }
    if (req.method === 'POST' && url.pathname === OBSIDIAN_ROUTES.notes) {
      const { cursor = null, since = 0 } = json();
      const notes = [...vaultNotes]
        .filter(([path, note]) => (cursor === null || path > cursor) && note.mtime > since)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, note]) => ({ path, mtime: note.mtime, size: Buffer.byteLength(note.text) }));
      return send(200, { ok: true, notes, next: null, capped: false });
    }
    if (req.method === 'POST' && url.pathname === OBSIDIAN_ROUTES.read) {
      const paths = json().paths ?? [];
      if (!paths.every(isSafeNotePath)) return fail(400, 'invalid', 'That is not a Markdown note inside the vault.');
      const notes = paths
        .filter(path => vaultNotes.has(path))
        .map(path => ({ path, ...vaultNotes.get(path), size: Buffer.byteLength(vaultNotes.get(path).text) }));
      return send(200, { ok: true, notes, skipped: [] });
    }
    if (req.method === 'POST' && url.pathname === OBSIDIAN_ROUTES.write) {
      const parsed = obsidianWriteRequestSchema.safeParse(json());
      if (!parsed.success) return fail(400, 'invalid', 'The vault request is not valid.');
      const existing = vaultNotes.get(parsed.data.path);
      const marked = text => /^---\r?\n[\s\S]*?^source: avi-copilot$[\s\S]*?^---/m.test(text);
      if (existing && parsed.data.mode === 'create') return fail(400, 'invalid', 'A note already exists at that path.');
      if (existing && parsed.data.onlyIfMarker && !marked(existing.text)) {
        return fail(403, 'forbidden', 'That note is not one Nex Copilot wrote, so it was left alone.');
      }
      vaultNotes.set(parsed.data.path, { text: parsed.data.text, mtime: Date.now() });
      return send(200, { ok: true, path: parsed.data.path, mtime: Date.now(), created: !existing });
    }
    if (req.method === 'POST' && url.pathname === OBSIDIAN_ROUTES.remove) {
      return send(200, { ok: true, removed: vaultNotes.delete(json().path) });
    }
    // The Mac's Calendar: its permission flips to granted when "Allow access" asks
    const calendarStatus = () => ({
      ok: true,
      access: calendar.access,
      calendars: calendar.access === 'granted' ? calendar.calendars : [],
      message: calendar.access === 'granted' ? null : 'Nex Brain needs your permission to read the Mac’s Calendar.',
    });
    if (req.method === 'POST' && url.pathname === CALENDAR_ROUTES.status) return send(200, calendarStatus());
    if (req.method === 'POST' && url.pathname === CALENDAR_ROUTES.request) {
      if (calendar.access === 'not_determined') calendar.access = 'granted';
      return send(200, calendarStatus());
    }
    if (req.method === 'POST' && url.pathname === CALENDAR_ROUTES.events) {
      const parsed = calendarEventsRequestSchema.safeParse(json());
      if (!parsed.success) return fail(400, 'invalid', 'The calendar request is not valid.');
      if (calendar.access !== 'granted')
        return fail(403, 'forbidden', 'Nex Brain needs your permission to read the Mac’s Calendar.');
      calendar.eventRequests.push(parsed.data);
      const ids = parsed.data.calendarIds;
      return send(200, {
        ok: true,
        truncated: false,
        events: calendar.events.filter(event => ids === null || ids.includes(event.calendarId)),
      });
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
    backups,
    backupSecrets: () => backupSecrets,
    vaultNotes,
    calendar,
    chosenVault: () => chosenVault,
    async close() {
      server.closeAllConnections();
      remote.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => remote.close(resolve));
    },
  };
}
