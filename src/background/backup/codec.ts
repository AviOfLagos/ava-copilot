/**
 * How values that JSON cannot hold travel in a snapshot: Blobs (attachments, thumbnails), byte arrays and
 * dates become small tagged objects, and come back as what they were. Plus gzip, base64 and SHA-256 over
 * bytes, with the browser's own CompressionStream and WebCrypto (no dependency, and the same in Node for tests).
 */

const TAG = '$nex';

type Tagged =
  | { $nex: 'blob'; type: string; data: string }
  | { $nex: 'bytes'; kind: string; data: string }
  | { $nex: 'date'; value: number }
  // An object of the user's that happens to have a "$nex" key, kept as it was
  | { $nex: 'object'; value: Record<string, unknown> };

const BYTE_KINDS: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
};

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/** Whether a value holds anything JSON would lose, so plain rows skip the slower walk. */
function needsEncoding(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof Blob || value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return true;
  }
  if (Array.isArray(value)) return value.some(needsEncoding);
  if (TAG in value) return true;
  for (const key in value) if (needsEncoding((value as Record<string, unknown>)[key])) return true;
  return false;
}

/** A value as JSON can hold it. */
export async function encodeValue(value: unknown): Promise<unknown> {
  if (!needsEncoding(value)) return value;
  return encodeDeep(value);
}

async function encodeDeep(value: unknown): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Blob) {
    return { [TAG]: 'blob', type: value.type, data: toBase64(new Uint8Array(await value.arrayBuffer())) } as Tagged;
  }
  if (value instanceof Date) return { [TAG]: 'date', value: value.getTime() } as Tagged;
  if (value instanceof ArrayBuffer)
    return { [TAG]: 'bytes', kind: 'ArrayBuffer', data: toBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { [TAG]: 'bytes', kind: value.constructor.name, data: toBase64(bytes) } as Tagged;
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeDeep));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key] = await encodeDeep(inner);
  return TAG in value ? ({ [TAG]: 'object', value: out } as Tagged) : out;
}

/** The value a snapshot held, with its Blobs, byte arrays and dates back. */
export function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  if (!isPlainObject(value)) return value;
  const tag = value[TAG];
  if (typeof tag === 'string') {
    if (tag === 'blob' && typeof value.data === 'string') {
      return new Blob([fromBase64(value.data)], { type: typeof value.type === 'string' ? value.type : '' });
    }
    if (tag === 'date' && typeof value.value === 'number') return new Date(value.value);
    if (tag === 'bytes' && typeof value.data === 'string') {
      const bytes = fromBase64(value.data);
      if (value.kind === 'ArrayBuffer') return bytes.buffer;
      const Kind = BYTE_KINDS[String(value.kind)] ?? Uint8Array;
      return new Kind(bytes.buffer);
    }
    if (tag === 'object' && isPlainObject(value.value)) {
      return Object.fromEntries(Object.entries(value.value).map(([key, inner]) => [key, decodeValue(inner)]));
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, decodeValue(inner)]));
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number, tooLarge: string): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(tooLarge);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function gzip(data: Blob, limit = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
  return readAll(data.stream().pipeThrough(new CompressionStream('gzip')), limit, 'This backup is too large to keep.');
}

/** Unzips at most `limit` bytes: a small file that unpacks to gigabytes stops there. */
export async function gunzip(data: Uint8Array<ArrayBuffer>, limit: number): Promise<Uint8Array> {
  return readAll(
    new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip')),
    limit,
    'This backup unpacks to more than Nex Copilot can read.',
  );
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
