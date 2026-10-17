/**
 * What `scripts/voice-models-setup.mjs` and `scripts/wake-word-setup.mjs` do to two downloads after they are
 * checked, done in the browser with its own streams (no zip or tar library): KittenTTS's voices.npz becomes one
 * raw float32 file per voice plus an index, and the Vosk model's zip becomes the tar.gz Vosk reads plus the word
 * list the wake phrase is checked against. Only data is read; nothing here runs code.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  dataStart: number;
}

const decoder = new TextDecoder();

/** The entries of a zip archive (central directory), without reading their data yet. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('The zip archive has a broken directory');
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.push({ name, method, compressedSize, dataStart });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One entry's data: stored, or deflated (inflated with the browser's own DecompressionStream). */
export async function zipEntryData(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const raw = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`${entry.name} uses compression ${entry.method}`);
  return collect(new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
}

/** A NumPy .npy array of little-endian float32 in C order: its shape and raw data. */
export function readNpy(bytes: Uint8Array): { shape: number[]; data: Uint8Array } {
  if (decoder.decode(bytes.subarray(1, 6)) !== 'NUMPY') throw new Error('Not a .npy array');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  const headerLength = major >= 2 ? view.getUint32(8, true) : view.getUint16(8, true);
  const start = major >= 2 ? 12 : 10;
  const header = decoder.decode(bytes.subarray(start, start + headerLength));
  if (!/'descr':\s*'<f4'/.test(header) || /'fortran_order':\s*True/.test(header)) {
    throw new Error(`Unexpected array layout: ${header.trim()}`);
  }
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(Number);
  return { shape, data: bytes.subarray(start + headerLength) };
}

export interface OutputFile {
  path: string;
  data: Uint8Array | string;
}

/**
 * KittenTTS: one raw float32 file per voice (voices/<key>.bin), the index with the friendly names and speeds
 * (voices.json), and the config.json that makes transformers.js load the ONNX file as a StyleTTS 2 model.
 */
export async function kittenVoiceFiles(kittenJson: string, npz: Uint8Array): Promise<OutputFile[]> {
  const config = JSON.parse(kittenJson) as {
    voice_aliases: Record<string, string>;
    speed_priors?: Record<string, number>;
  };
  const entries = new Map(zipEntries(npz).map(entry => [entry.name, entry]));
  const files: OutputFile[] = [];
  const voices: Record<string, { key: string; speed: number }> = {};
  let styles = 0;
  let styleDim = 0;
  for (const [alias, key] of Object.entries(config.voice_aliases)) {
    const entry = entries.get(`${key}.npy`);
    if (!entry) throw new Error(`voices.npz has no voice ${key}`);
    const { shape, data } = readNpy(await zipEntryData(npz, entry));
    [styles, styleDim] = shape;
    files.push({ path: `voices/${key}.bin`, data: data.slice() });
    voices[alias] = { key, speed: config.speed_priors?.[key] ?? 1 };
  }
  files.push({ path: 'config.json', data: JSON.stringify({ model_type: 'style_text_to_speech_2' }) });
  files.push({ path: 'voices.json', data: JSON.stringify({ sampleRate: 24000, styles, styleDim, voices }, null, 2) });
  return files;
}

// OpenFst's symbol table magic number, which starts the word list embedded in Gr.fst
const SYMBOL_TABLE_MAGIC = 2125658996;

/** The words in an OpenFst binary file's first embedded symbol table, without the special ones. */
export function readSymbolTable(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = -1;
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (view.getInt32(i, true) === SYMBOL_TABLE_MAGIC) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error('No word list in the model graph');
  at += 4;
  const nameLength = view.getInt32(at, true);
  at += 4 + nameLength + 8; // name, then the next free key
  const size = Number(view.getBigInt64(at, true));
  at += 8;
  const words: string[] = [];
  for (let i = 0; i < size; i++) {
    const length = view.getInt32(at, true);
    at += 4;
    words.push(decoder.decode(bytes.subarray(at, at + length)));
    at += length + 8; // the word, then its key
  }
  return words.filter(word => !/^(<.*>|#\d+|!SIL|\[unk\])$/.test(word));
}

const encoder = new TextEncoder();

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

/** A POSIX ustar header for a file or a folder. */
export function tarHeader(name: string, size: number, directory: boolean): Uint8Array {
  const header = new Uint8Array(512);
  let prefix = '';
  let short = name;
  if (encoder.encode(name).length > 100) {
    const cut = name.lastIndexOf('/', name.length - 2);
    prefix = name.slice(0, cut);
    short = name.slice(cut + 1);
    if (encoder.encode(short).length > 100 || encoder.encode(prefix).length > 155) {
      throw new Error(`${name} is too long for a tar archive`);
    }
  }
  const put = (text: string, offset: number) => header.set(encoder.encode(text), offset);
  put(short, 0);
  put(octal(directory ? 0o755 : 0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(size, 12), 124);
  put(octal(0, 12), 136);
  put('        ', 148); // the checksum counts as spaces while it is summed
  put(directory ? '5' : '0', 156);
  put('ustar\0', 257);
  put('00', 263);
  put(prefix, 345);
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

/** Whether a zip entry is macOS metadata (`__MACOSX/`, `._name`), which must not become model files. */
function isMetadata(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.split('/').some(part => part.startsWith('._'));
}

/**
 * The Vosk model's zip as the gzipped tar Vosk reads (its folders first, then each file), made one entry at a
 * time so the whole model is never held twice, and its vocabulary from graph/Gr.fst.
 */
export function voskArchive(
  zip: Uint8Array,
  modelDir: string,
): { tarGz: ReadableStream<Uint8Array>; words: Promise<string[]> } {
  const entries = zipEntries(zip).filter(entry => !isMetadata(entry.name) && entry.name.startsWith(`${modelDir}/`));
  const graph = entries.find(entry => entry.name === `${modelDir}/graph/Gr.fst`);
  if (!graph) throw new Error('The model has no graph/Gr.fst');
  const words = zipEntryData(zip, graph).then(readSymbolTable);
  words.catch(() => {});
  const folders = new Set<string>();
  for (const entry of entries) {
    const parts = entry.name.split('/').filter(Boolean);
    const last = entry.name.endsWith('/') ? parts.length : parts.length - 1;
    for (let i = 1; i <= last; i++) folders.add(`${parts.slice(0, i).join('/')}/`);
  }
  const queue: (() => Promise<Uint8Array[]>)[] = [
    ...[...folders].sort().map(folder => async () => [tarHeader(folder, 0, true)]),
    ...entries
      .filter(entry => !entry.name.endsWith('/'))
      .map(entry => async () => {
        const data = await zipEntryData(zip, entry);
        const padding = (512 - (data.length % 512)) % 512;
        return [tarHeader(entry.name, data.length, false), data, new Uint8Array(padding)];
      }),
    // Two empty blocks end the archive
    async () => [new Uint8Array(1024)],
  ];
  let next = 0;
  const tar = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const make = queue[next++];
      if (!make) {
        controller.close();
        return;
      }
      for (const chunk of await make()) controller.enqueue(chunk);
    },
  });
  return {
    tarGz: tar.pipeThrough(new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>),
    words,
  };
}
