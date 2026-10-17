import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import type { CatalogComponent, VoiceModelCatalog } from '../catalog';
import { VOICE_MODEL_CATALOG } from '../catalog';

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export const bytesOf = (size: number, seed = 1) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 251);

/** A zip archive (stored or deflated entries) with a central directory, as Python's zipfile writes it. */
export function makeZip(entries: { name: string; data: Uint8Array; deflate?: boolean }[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const body = entry.deflate ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, entry.deflate ? 8 : 0, true);
    view.setUint32(18, body.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, name.length, true);
    header.set(name, 30);
    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(10, entry.deflate ? 8 : 0, true);
    recordView.setUint32(20, body.length, true);
    recordView.setUint32(24, entry.data.length, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint32(42, offset, true);
    record.set(name, 46);
    local.push(header, body);
    central.push(record);
    offset += header.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const parts = [...local, ...central, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A NumPy .npy file of float32 values. */
export function makeNpy(shape: number[], values: Float32Array): Uint8Array {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(', ')}), }`;
  const pad = 64 - ((10 + header.length + 1) % 64);
  header = `${header}${' '.repeat(pad % 64)}\n`;
  const out = new Uint8Array(10 + header.length + values.byteLength);
  out.set([0x93, ...new TextEncoder().encode('NUMPY'), 1, 0]);
  new DataView(out.buffer).setUint16(8, header.length, true);
  out.set(new TextEncoder().encode(header), 10);
  out.set(new Uint8Array(values.buffer), 10 + header.length);
  return out;
}

/** A served file set: url → bytes, and a catalog of them. */
export function servedComponent(
  id: CatalogComponent['id'],
  files: Record<string, Uint8Array>,
  unpack?: CatalogComponent['unpack'],
): { component: CatalogComponent; served: Map<string, Uint8Array>; catalog: VoiceModelCatalog } {
  const served = new Map<string, Uint8Array>();
  const component: CatalogComponent = {
    id,
    unpack,
    files: Object.entries(files).map(([path, data]) => {
      const url = `http://127.0.0.1:9/${id}/${path}`;
      served.set(url, data);
      return { path, url, bytes: data.length, sha256: sha256(data) };
    }),
  };
  return { component, served, catalog: { ...VOICE_MODEL_CATALOG, [id]: component } };
}

export interface FakeServer {
  fetch: typeof fetch;
  requests: { url: string; range: string | null }[];
  // Cut the next responses off after this many bytes (one entry per response)
  cutAfter: number[];
  // Serve these bytes instead for a URL
  tamper: Map<string, Uint8Array>;
  // Hears each chunk sent (bytes so far in this response)
  onChunk?: (sent: number) => void;
}

/** A file server honouring Range, which can drop a connection mid-body or serve the wrong bytes. */
export function fakeServer(served: Map<string, Uint8Array>): FakeServer {
  const server: FakeServer = {
    requests: [],
    cutAfter: [],
    tamper: new Map(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const range = headers.get('range');
      server.requests.push({ url, range });
      const data = server.tamper.get(url) ?? served.get(url);
      if (!data) return new Response(null, { status: 404 });
      const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
      const body = data.subarray(start);
      const cut = server.cutAfter.shift();
      const signal = init?.signal;
      let at = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (cut !== undefined && at >= cut) {
            controller.error(new TypeError('network connection lost'));
            return;
          }
          if (signal?.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'));
            return;
          }
          if (at >= body.length) {
            controller.close();
            return;
          }
          controller.enqueue(body.slice(at, at + 7));
          at += 7;
          server.onChunk?.(at);
        },
      });
      return new Response(stream, {
        status: start ? 206 : 200,
        headers: start ? { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } : {},
      });
    }) as typeof fetch,
  };
  return server;
}
