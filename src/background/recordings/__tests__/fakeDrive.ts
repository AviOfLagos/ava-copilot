/**
 * A stand-in for Google Drive's REST and resumable-upload endpoints, in memory. It never reaches Google.
 * `dropOnce(bytes)` makes the next upload piece that would take a session past `bytes` keep only what fits below
 * it (on a 256 KiB boundary, as Drive does) and then fail like a dropped connection.
 */

export const API = 'https://drive.fake/drive/v3';
export const UPLOAD = 'https://drive.fake/upload/drive/v3';
const QUANTUM = 256 * 1024;

interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  bytes: Uint8Array | null;
  permissions: { id: string; type: string; role: string }[];
}

interface Session {
  name: string;
  parents: string[];
  mimeType: string;
  size: number;
  parts: Uint8Array[];
  received: number;
  fileId: string | null;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export function fakeDrive(options: { token?: string } = {}) {
  let token = options.token ?? 'token-1';
  const files = new Map<string, FakeFile>();
  const sessions = new Map<string, Session>();
  const calls: { method: string; url: string }[] = [];
  let drop: number | null = null;
  let next = 1;

  const authorized = (init?: RequestInit) =>
    (init?.headers as Record<string, string> | undefined)?.Authorization === `Bearer ${token}`;

  async function handle(url: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? 'GET';
    calls.push({ method, url });
    if (!authorized(init)) return json({ error: { code: 401 } }, 401);
    const address = new URL(url);
    const path = address.pathname;

    if (sessions.has(url)) {
      const session = sessions.get(url)!;
      const range = (init.headers as Record<string, string>)['Content-Range'];
      const status = () =>
        session.fileId
          ? json({ id: session.fileId, name: session.name }, 200)
          : new Response(null, {
              status: 308,
              headers: session.received ? { Range: `bytes=0-${session.received - 1}` } : {},
            });
      if (/^bytes \*\/\d+$/.test(range)) return status();
      const match = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!match) return json({ error: { code: 400 } }, 400);
      const start = Number(match[1]);
      if (start !== session.received) return json({ error: { code: 400, message: 'wrong offset' } }, 400);
      let data = new Uint8Array(await (init.body as Blob).arrayBuffer());
      if (drop !== null && session.received + data.length > drop) {
        const keep = Math.max(0, Math.floor((drop - session.received) / QUANTUM) * QUANTUM);
        session.parts.push(data.slice(0, keep));
        session.received += keep;
        drop = null;
        throw new TypeError('Failed to fetch');
      }
      session.parts.push(data);
      session.received += data.length;
      if (session.received === session.size) {
        const id = `file${next++}`;
        const bytes = new Uint8Array(session.size);
        let offset = 0;
        for (const part of session.parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        files.set(id, {
          id,
          name: session.name,
          parents: session.parents,
          mimeType: session.mimeType,
          bytes,
          permissions: [{ id: 'owner', type: 'user', role: 'owner' }],
        });
        session.fileId = id;
        data = new Uint8Array();
      }
      return status();
    }

    if (
      url.startsWith(`${UPLOAD}/files`) &&
      method === 'POST' &&
      address.searchParams.get('uploadType') === 'resumable'
    ) {
      const meta = JSON.parse(String(init.body)) as { name: string; parents: string[]; mimeType: string };
      const size = Number((init.headers as Record<string, string>)['X-Upload-Content-Length']);
      const location = `https://drive.fake/upload/session/${next++}`;
      sessions.set(location, { ...meta, size, parts: [], received: 0, fileId: null });
      return new Response(null, { status: 200, headers: { Location: location } });
    }

    if (path === '/drive/v3/files' && method === 'GET') {
      const q = address.searchParams.get('q') ?? '';
      const name = q.match(/name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\(.)/g, '$1');
      const parent = q.match(/'([^']+)' in parents/)?.[1];
      const found = [...files.values()].filter(
        file => file.name === name && file.parents.includes(parent!) && file.mimeType.endsWith('folder'),
      );
      return json({ files: found.slice(0, 1).map(file => ({ id: file.id })) });
    }
    if (path === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(String(init.body)) as { name: string; parents: string[]; mimeType: string };
      const id = `folder${next++}`;
      files.set(id, { id, ...meta, bytes: null, permissions: [] });
      return json({ id });
    }
    const fileMatch = path.match(/^\/drive\/v3\/files\/([^/]+)(\/permissions(?:\/([^/]+))?)?$/);
    if (fileMatch) {
      const file = files.get(decodeURIComponent(fileMatch[1]));
      if (!file) return json({ error: { code: 404 } }, 404);
      if (!fileMatch[2]) return json({ id: file.id, webViewLink: `https://drive.google.com/file/d/${file.id}/view` });
      if (method === 'GET') return json({ permissions: file.permissions });
      if (method === 'POST') {
        const body = JSON.parse(String(init.body)) as { type: string; role: string };
        const permission = { id: body.type === 'anyone' ? 'anyoneWithLink' : `p${next++}`, ...body };
        file.permissions.push(permission);
        return json({ id: permission.id });
      }
      if (method === 'DELETE') {
        const before = file.permissions.length;
        file.permissions = file.permissions.filter(permission => permission.id !== decodeURIComponent(fileMatch[3]));
        return before === file.permissions.length
          ? json({ error: { code: 404 } }, 404)
          : new Response(null, { status: 204 });
      }
    }
    return json({ error: { code: 404, message: `no fake for ${method} ${path}` } }, 404);
  }

  return {
    fetch: (url: string, init?: RequestInit) => handle(url, init),
    files,
    sessions,
    calls,
    dropOnce(bytes: number) {
      drop = bytes;
    },
    expireToken(newToken: string) {
      token = newToken;
    },
    uploads: () => [...files.values()].filter(file => file.bytes !== null),
    folders: () => [...files.values()].filter(file => file.bytes === null),
    // What a signed-out browser can open: a file with an "anyone" permission
    opensSignedOut: (id: string) =>
      Boolean(files.get(id)?.permissions.some(permission => permission.type === 'anyone')),
  };
}

export type FakeDrive = ReturnType<typeof fakeDrive>;

/** Byte for byte, without vitest's deep compare (far too slow on megabytes). */
export const same = async (a: Uint8Array | null, blob: Blob) =>
  a !== null && Buffer.compare(Buffer.from(a), Buffer.from(await blob.arrayBuffer())) === 0;
