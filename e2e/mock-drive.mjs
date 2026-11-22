import fs from 'node:fs';

/**
 * Google Drive's REST and resumable-upload endpoints, answered by the test through the browser's Fetch interception
 * (CDP), so nothing reaches Google. `dropNextPiece()` fails the next upload piece like a dropped connection.
 */

const QUANTUM = 256 * 1024;

export function createMockDrive() {
  const files = new Map();
  const sessions = new Map();
  const calls = [];
  let dropNext = false;
  let next = 1;

  const reply = (status, body, headers = {}) => ({
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? '' : JSON.stringify(body),
  });

  function bodyBytes(request) {
    if (request.postDataEntries?.length) {
      return Buffer.concat(request.postDataEntries.map(entry => Buffer.from(entry.bytes ?? '', 'base64')));
    }
    return request.postData ? Buffer.from(request.postData, 'utf8') : Buffer.alloc(0);
  }

  /** @returns a response, or 'drop' to fail the request like a dropped connection */
  function handle(request) {
    const url = new URL(request.url);
    const method = request.method;
    calls.push({ method, url: request.url });
    const auth = request.headers.Authorization ?? request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return reply(401, { error: { code: 401 } });

    const session = sessions.get(request.url);
    if (session) {
      const range = request.headers['Content-Range'] ?? request.headers['content-range'];
      const status = () =>
        session.fileId
          ? reply(200, { id: session.fileId, name: session.name })
          : { status: 308, headers: session.received ? { Range: `bytes=0-${session.received - 1}` } : {}, body: '' };
      if (/^bytes \*\/\d+$/.test(range)) return status();
      const match = range?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!match || Number(match[1]) !== session.received) return reply(400, { error: { code: 400 } });
      const length = Number(match[2]) - Number(match[1]) + 1;
      if (dropNext) {
        dropNext = false;
        return 'drop';
      }
      const bytes = bodyBytes(request);
      session.parts.push(bytes.length === length ? bytes : Buffer.alloc(0));
      session.received += length;
      if (session.received === session.size) {
        const id = `file${next++}`;
        files.set(id, {
          id,
          name: session.name,
          parents: session.parents,
          mimeType: session.mimeType,
          bytes: Buffer.concat(session.parts),
          size: session.size,
          permissions: [{ id: 'owner', type: 'user', role: 'owner' }],
        });
        session.fileId = id;
      }
      return status();
    }

    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(request.postData ?? '{}');
      const location = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fake${next++}`;
      sessions.set(location, {
        ...meta,
        size: Number(request.headers['X-Upload-Content-Length']),
        parts: [],
        received: 0,
        fileId: null,
      });
      return { status: 200, headers: { Location: location }, body: '' };
    }
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const name = q.match(/name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\(.)/g, '$1');
      const parent = q.match(/'([^']+)' in parents/)?.[1];
      const found = [...files.values()].filter(f => f.folder && f.name === name && f.parents.includes(parent));
      return reply(200, { files: found.slice(0, 1).map(f => ({ id: f.id })) });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(request.postData ?? '{}');
      const id = `folder${next++}`;
      files.set(id, { id, ...meta, folder: true, permissions: [] });
      return reply(200, { id });
    }
    const match = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/permissions(?:\/([^/]+))?)?$/);
    if (match) {
      const file = files.get(decodeURIComponent(match[1]));
      if (!file) return reply(404, { error: { code: 404 } });
      if (!match[2]) return reply(200, { id: file.id, webViewLink: `https://drive.google.com/file/d/${file.id}/view` });
      if (method === 'GET') return reply(200, { permissions: file.permissions });
      if (method === 'POST') {
        const body = JSON.parse(request.postData ?? '{}');
        const permission = { id: body.type === 'anyone' ? 'anyoneWithLink' : `p${next++}`, ...body };
        file.permissions.push(permission);
        return reply(200, { id: permission.id });
      }
      if (method === 'DELETE') {
        file.permissions = file.permissions.filter(p => p.id !== decodeURIComponent(match[3]));
        return { status: 204, headers: {}, body: '' };
      }
    }
    return reply(404, { error: { code: 404 } });
  }

  return {
    files,
    sessions,
    calls,
    handle,
    dropNextPiece: () => (dropNext = true),
    uploads: () => [...files.values()].filter(file => !file.folder),
    folders: () => [...files.values()].filter(file => file.folder),
    // What a browser that is not signed in can open: a file with an "anyone" permission
    opensSignedOut: id => Boolean(files.get(id)?.permissions.some(p => p.type === 'anyone')),
    QUANTUM,
  };
}

/**
 * Answers every request the extension's service worker makes to www.googleapis.com with `drive`. A browser-wide
 * Fetch interception does not see a worker's own fetches, so this attaches to the worker itself, and again to any
 * worker that starts later (the background restarting). A request that slipped past would carry the mock OAuth
 * server's made-up token, which Google refuses.
 */
export async function interceptDrive(browser, drive, origin) {
  const hooked = new WeakSet();
  const hook = async target => {
    if (target.type() !== 'service_worker' || !target.url().startsWith(origin) || hooked.has(target)) return;
    hooked.add(target);
    const cdp = await target.createCDPSession();
    cdp.on('Fetch.requestPaused', async event => {
      const answer = drive.handle(event.request);
      if (process.env.E2E_DRIVE_DEBUG) {
        fs.appendFileSync(
          process.env.E2E_DRIVE_DEBUG,
          `${event.request.method} ${event.request.url.slice(0, 90)} ${answer === 'drop' ? 'drop' : answer.status}\n`,
        );
      }
      if (answer === 'drop') {
        await cdp
          .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionReset' })
          .catch(() => {});
        return;
      }
      await cdp
        .send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: answer.status,
          responseHeaders: Object.entries(answer.headers).map(([name, value]) => ({ name, value: String(value) })),
          body: Buffer.from(answer.body).toString('base64'),
        })
        .catch(() => {});
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.googleapis.com/*' }] });
  };
  browser.on('targetcreated', target => void hook(target));
  for (const target of browser.targets()) await hook(target);
}
