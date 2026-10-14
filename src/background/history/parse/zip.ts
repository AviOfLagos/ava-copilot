/**
 * Reads one file out of a zip, such as `conversations.json` from a ChatGPT or Claude.ai data export,
 * with the browser's own DecompressionStream (no library). Only stored and deflated entries, which is
 * what these exports use; returns null when the file is not in the zip.
 */

// The most a single file from a zip may unpack to
const MAX_UNPACKED = 512 * 1024 * 1024;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipEntry(zip: Blob, wanted: (name: string) => boolean): Promise<string | null> {
  // The central directory's end record sits in the last 64 KiB (plus its 22 bytes)
  const tailStart = Math.max(0, zip.size - 65_558);
  const tail = new DataView(await zip.slice(tailStart).arrayBuffer());
  let end = -1;
  for (let at = tail.byteLength - 22; at >= 0; at--) {
    if (tail.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const count = tail.getUint16(end + 10, true);
  const dirSize = tail.getUint32(end + 12, true);
  const dirOffset = tail.getUint32(end + 16, true);
  const dir = new DataView(await zip.slice(dirOffset, dirOffset + dirSize).arrayBuffer());
  const decoder = new TextDecoder();
  let at = 0;
  for (let n = 0; n < count && at + 46 <= dir.byteLength; n++) {
    if (dir.getUint32(at, true) !== 0x02014b50) return null;
    const method = dir.getUint16(at + 10, true);
    const compressed = dir.getUint32(at + 20, true);
    const size = dir.getUint32(at + 24, true);
    const nameLength = dir.getUint16(at + 28, true);
    const extraLength = dir.getUint16(at + 30, true);
    const commentLength = dir.getUint16(at + 32, true);
    const local = dir.getUint32(at + 42, true);
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + at + 46, nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    if (size > MAX_UNPACKED) throw new Error(`${name} is too large to read.`);
    const header = new DataView(await zip.slice(local, local + 30).arrayBuffer());
    if (header.getUint32(0, true) !== 0x04034b50) return null;
    const start = local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const raw = new Uint8Array(await zip.slice(start, start + compressed).arrayBuffer());
    if (method === 0) return decoder.decode(raw);
    if (method === 8) return decoder.decode(await inflate(raw));
    throw new Error(`${name} uses a compression this cannot read.`);
  }
  return null;
}
