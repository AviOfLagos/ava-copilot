#!/usr/bin/env node
/**
 * Puts the local voice models in public/voice/ (git-ignored), for Settings › Voice engines:
 *
 * - kitten          KittenTTS nano 0.8, int8 (KittenML, Apache-2.0): the local voice, 8 voices, ~28 MB
 * - moonshine-tiny  Moonshine tiny, int8 (Useful Sensors, MIT): local speech-to-text, ~32 MB
 * - moonshine-base  Moonshine base, int8 (MIT): more accurate, ~67 MB            (--moonshine-base)
 * - whisper-base    Whisper base, int8 (OpenAI, MIT): ~81 MB                       (--whisper)
 * - kokoro          Kokoro 82M v1.0, int8 (hexgrad, Apache-2.0): better voice, ~97 MB  (--kokoro)
 * - --webgpu        adds the float weights Moonshine needs on WebGPU (tiny ~75 MB, base ~154 MB)
 *
 * Every file comes from a pinned revision and is checked against a pinned SHA-256; files already in place
 * with the right sum are kept. This packs the models into a dev build. A normal install needs none of it: the
 * extension downloads the same pinned files on first use (src/shared/lib/voice-models/catalog.ts, kept equal to
 * COMPONENTS below by its test) into its own storage. KittenTTS's voices.npz is unpacked into one raw float32
 * file per voice, so the extension's runtime needs no zip reader.
 *
 * Run: node scripts/voice-models-setup.mjs [--moonshine-base] [--whisper] [--kokoro] [--webgpu] [--all]
 *      node scripts/voice-models-setup.mjs --list
 * Then rebuild (pnpm build) so the files are copied into dist/.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '../public/voice');
const HF = 'https://huggingface.co';

const KITTEN_REPO = 'KittenML/kitten-tts-nano-0.8-int8@84781d74e29ee25217551556398b42f80593a813';
const MOONSHINE_TINY = 'onnx-community/moonshine-tiny-ONNX@a6da1241cd305dcd64eab1edbd615f2bb9aabb95';
const MOONSHINE_BASE = 'onnx-community/moonshine-base-ONNX@b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad';
const WHISPER_BASE = 'onnx-community/whisper-base@1846881b6b3a3024392c1eea3ad983695bc23925';
const KOKORO = 'onnx-community/Kokoro-82M-v1.0-ONNX@1939ad2a8e416c0acfeecc08a694d14ef25f2231';

// Shared by both Moonshine sizes (same tokenizer and preprocessing)
const MOONSHINE_TEXT_FILES = {
  'generation_config.json': [147, 'f9b3f711b57be7def2e50a8942f64f36ee0a55fad5b84ff93a687b6c5bcc1d44'],
  'preprocessor_config.json': [128, 'fa43a7017ef85cd1d0fba0d9aae77c8adb16990ae6f11115631f41ec5d8aa679'],
  'special_tokens_map.json': [3, 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356'],
  'tokenizer.json': [3761754, '7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f'],
  'tokenizer_config.json': [135735, 'edaee394565d428ea98a663ae7209cdcfeefc5585c42d7a570ff7c986df2cd15'],
};

// The Kokoro voices offered (American and British English); each is 510 styles × 256 floats
const KOKORO_VOICES = {
  af_heart: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  af_bella: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  af_nicole: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
  af_sarah: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a',
  am_michael: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  am_fenrir: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43',
  bf_emma: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  bm_george: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
};

/**
 * Each component: files as `target path → [repo@revision, source path, bytes, sha256]`. `webgpu` lists the
 * extra float weights for running on the GPU.
 */
export const COMPONENTS = {
  kitten: {
    label: 'KittenTTS nano (local voice)',
    license: 'Apache-2.0',
    files: {
      'kitten.json': [
        KITTEN_REPO,
        'config.json',
        688,
        'b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64',
      ],
      'onnx/model_quantized.onnx': [
        KITTEN_REPO,
        'kitten_tts_nano_v0_8.onnx',
        24369971,
        'f7b0afcbee92870b32b8e0276d855b954dc25470c9f051b376ac7eee537c76fc',
      ],
      'voices.npz': [
        KITTEN_REPO,
        'voices.npz',
        3278902,
        '8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f',
      ],
    },
  },
  'moonshine-tiny': {
    label: 'Moonshine tiny (local speech-to-text)',
    license: 'MIT',
    files: {
      'config.json': [
        MOONSHINE_TINY,
        'config.json',
        921,
        '558e1e02069137c796ace1e50c48d8fe451f04a295929138e6bea885517f0edb',
      ],
      ...repoFiles(MOONSHINE_TINY, MOONSHINE_TEXT_FILES),
      'onnx/encoder_model_quantized.onnx': [
        MOONSHINE_TINY,
        'onnx/encoder_model_quantized.onnx',
        7937661,
        'c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a',
      ],
      'onnx/decoder_model_merged_quantized.onnx': [
        MOONSHINE_TINY,
        'onnx/decoder_model_merged_quantized.onnx',
        20243286,
        'eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367',
      ],
    },
    webgpu: {
      'onnx/encoder_model.onnx': [
        MOONSHINE_TINY,
        'onnx/encoder_model.onnx',
        30882331,
        'cbbf580f703b2af2137e0f6d14cd87f31cc67bd858bfd8715403a9489982d1a5',
      ],
      'onnx/decoder_model_merged_q4.onnx': [
        MOONSHINE_TINY,
        'onnx/decoder_model_merged_q4.onnx',
        44650684,
        '451510e9bc0d4d829e50f4feffda384a38fd0a7cc8aee72667b8fdb1fb4c7e08',
      ],
    },
  },
  'moonshine-base': {
    label: 'Moonshine base (local speech-to-text, more accurate)',
    license: 'MIT',
    optional: '--moonshine-base',
    files: {
      'config.json': [
        MOONSHINE_BASE,
        'config.json',
        922,
        'fab7241d1e9fc6c2370c4c6dfb5da79bb54d67ed9ab6b507ac51d29d2abe01d1',
      ],
      ...repoFiles(MOONSHINE_BASE, MOONSHINE_TEXT_FILES),
      'onnx/encoder_model_quantized.onnx': [
        MOONSHINE_BASE,
        'onnx/encoder_model_quantized.onnx',
        20513063,
        '1dd9ab0a7f987113d30affcba5a068d11c8f90fa0223caa3e491ade431ad9751',
      ],
      'onnx/decoder_model_merged_quantized.onnx': [
        MOONSHINE_BASE,
        'onnx/decoder_model_merged_quantized.onnx',
        42498870,
        'cc9f3cd6698a369c6008b41aa60aa3fb3322e7f03c9bdf19d8e6b7200afca4f3',
      ],
    },
    webgpu: {
      'onnx/encoder_model.onnx': [
        MOONSHINE_BASE,
        'onnx/encoder_model.onnx',
        80818781,
        '153e128e7abd64a74ee47f2c3f585c3171c4d46cbb368b032827934c4e01e779',
      ],
      'onnx/decoder_model_merged_q4.onnx': [
        MOONSHINE_BASE,
        'onnx/decoder_model_merged_q4.onnx',
        72781828,
        '9f26db50c9f3b2eb1962ab93e9753f908c56367817d791032af58cbf7dba3803',
      ],
    },
  },
  'whisper-base': {
    label: 'Whisper base (local speech-to-text)',
    license: 'MIT',
    optional: '--whisper',
    files: {
      'config.json': [
        WHISPER_BASE,
        'config.json',
        2243,
        'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b',
      ],
      'generation_config.json': [
        WHISPER_BASE,
        'generation_config.json',
        3832,
        '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0',
      ],
      'preprocessor_config.json': [
        WHISPER_BASE,
        'preprocessor_config.json',
        339,
        'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
      ],
      'special_tokens_map.json': [
        WHISPER_BASE,
        'special_tokens_map.json',
        2194,
        'e67ae3a0aaa99abcd9f187138e12db1f65c16a14761c50ef10eef2c174a7a691',
      ],
      'tokenizer.json': [
        WHISPER_BASE,
        'tokenizer.json',
        2480466,
        '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
      ],
      'tokenizer_config.json': [
        WHISPER_BASE,
        'tokenizer_config.json',
        282682,
        '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573',
      ],
      'onnx/encoder_model_quantized.onnx': [
        WHISPER_BASE,
        'onnx/encoder_model_quantized.onnx',
        23201314,
        '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46',
      ],
      'onnx/decoder_model_merged_quantized.onnx': [
        WHISPER_BASE,
        'onnx/decoder_model_merged_quantized.onnx',
        53693315,
        'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
      ],
    },
  },
  kokoro: {
    label: 'Kokoro 82M (local voice, higher quality)',
    license: 'Apache-2.0',
    optional: '--kokoro',
    files: {
      'config.json': [KOKORO, 'config.json', 44, 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f'],
      'tokenizer.json': [
        KOKORO,
        'tokenizer.json',
        3497,
        '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
      ],
      'tokenizer_config.json': [
        KOKORO,
        'tokenizer_config.json',
        113,
        'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
      ],
      'onnx/model_quantized.onnx': [
        KOKORO,
        'onnx/model_quantized.onnx',
        92361116,
        'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
      ],
      ...Object.fromEntries(
        Object.entries(KOKORO_VOICES).map(([voice, sha256]) => [
          `voices/${voice}.bin`,
          [KOKORO, `voices/${voice}.bin`, 522240, sha256],
        ]),
      ),
    },
  },
};

function repoFiles(repo, files) {
  return Object.fromEntries(
    Object.entries(files).map(([name, [bytes, sha256]]) => [name, [repo, name, bytes, sha256]]),
  );
}

const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex');

function fileOk(file, bytes, sha256) {
  if (!fs.existsSync(file) || fs.statSync(file).size !== bytes) return false;
  return sha256Of(fs.readFileSync(file)) === sha256;
}

async function download([repoAtRevision, source, bytes, sha256], file) {
  if (fileOk(file, bytes, sha256)) return false;
  const [repo, revision] = repoAtRevision.split('@');
  const url = `${HF}/${repo}/resolve/${revision}/${source}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const sum = sha256Of(data);
  if (sum !== sha256) throw new Error(`${url}: checksum ${sum} is not the pinned ${sha256}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.part`, data);
  fs.renameSync(`${file}.part`, file);
  return true;
}

/** The entries of a zip archive (stored or deflated), as name → bytes. Enough for a NumPy .npz. */
function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('voices.npz is not a zip archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('voices.npz has a broken directory');
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressed);
    entries[name] = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!entries[name]) throw new Error(`voices.npz: ${name} uses compression ${method}`);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** A NumPy .npy array of little-endian float32 in C order: its shape and raw data. */
function readNpy(bytes) {
  if (bytes.toString('latin1', 1, 6) !== 'NUMPY') throw new Error('not a .npy array');
  const major = bytes[6];
  const headerLength = major >= 2 ? bytes.readUInt32LE(8) : bytes.readUInt16LE(8);
  const start = major >= 2 ? 12 : 10;
  const header = bytes.toString('latin1', start, start + headerLength);
  if (!/'descr':\s*'<f4'/.test(header) || /'fortran_order':\s*True/.test(header)) {
    throw new Error(`unexpected array layout: ${header.trim()}`);
  }
  const shape = /'shape':\s*\(([^)]*)\)/
    .exec(header)[1]
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(Number);
  return { shape, data: bytes.subarray(start + headerLength) };
}

/** KittenTTS: one raw float32 file per voice, and an index with the friendly names and speeds. */
function unpackKittenVoices(dir) {
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'kitten.json'), 'utf8'));
  const entries = readZip(fs.readFileSync(path.join(dir, 'voices.npz')));
  const voices = {};
  let styles = 0;
  let styleDim = 0;
  for (const [alias, key] of Object.entries(config.voice_aliases)) {
    const entry = entries[`${key}.npy`];
    if (!entry) throw new Error(`voices.npz has no voice ${key}`);
    const { shape, data } = readNpy(entry);
    [styles, styleDim] = shape;
    fs.mkdirSync(path.join(dir, 'voices'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'voices', `${key}.bin`), data);
    voices[alias] = { key, speed: config.speed_priors?.[key] ?? 1 };
  }
  // transformers.js loads the ONNX file as a StyleTTS 2 model (inputs input_ids, style, speed)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model_type: 'style_text_to_speech_2' }));
  fs.writeFileSync(
    path.join(dir, 'voices.json'),
    JSON.stringify({ sampleRate: 24000, styles, styleDim, voices }, null, 2),
  );
}

function folderBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? folderBytes(full) : fs.statSync(full).size;
  }
  return total;
}

function chosen(args) {
  const all = args.includes('--all');
  return Object.entries(COMPONENTS)
    .filter(([, component]) => !component.optional || all || args.includes(component.optional))
    .map(([id]) => id);
}

async function main() {
  const args = process.argv.slice(2);
  const webgpu = args.includes('--webgpu') || args.includes('--all');
  if (args.includes('--list')) {
    for (const [id, component] of Object.entries(COMPONENTS)) {
      const bytes = Object.values(component.files).reduce((sum, file) => sum + file[2], 0);
      const gpu = Object.values(component.webgpu ?? {}).reduce((sum, file) => sum + file[2], 0);
      console.log(
        `${id.padEnd(15)} ${(bytes / 1e6).toFixed(0).padStart(4)} MB${gpu ? ` (+${(gpu / 1e6).toFixed(0)} MB --webgpu)` : ''}  ${component.label} [${component.license}]${component.optional ? `  ${component.optional}` : ''}`,
      );
    }
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const manifestFile = path.join(OUT, 'manifest.json');
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    : { version: 1, components: {} };

  for (const id of chosen(args)) {
    const component = COMPONENTS[id];
    const dir = path.join(OUT, id);
    const files = { ...component.files, ...(webgpu ? (component.webgpu ?? {}) : {}) };
    console.log(`${component.label}…`);
    // KittenTTS's voices are unpacked from voices.npz once; the archive itself is not kept
    const voicesUnpacked = id === 'kitten' && fs.existsSync(path.join(dir, 'voices.json'));
    for (const [target, source] of Object.entries(files)) {
      if (target === 'voices.npz' && voicesUnpacked) continue;
      const fetched = await download(source, path.join(dir, target));
      if (fetched) console.log(`  ${target} (${(source[2] / 1e6).toFixed(1)} MB)`);
    }
    if (id === 'kitten' && !voicesUnpacked) {
      unpackKittenVoices(dir);
      fs.rmSync(path.join(dir, 'voices.npz'));
    }
    const gpuReady = Object.entries(component.webgpu ?? {}).every(([target, [, , bytes, sha256]]) =>
      fileOk(path.join(dir, target), bytes, sha256),
    );
    manifest.components[id] = {
      bytes: folderBytes(dir),
      webgpu: Boolean(component.webgpu) && gpuReady,
      installedAt: new Date().toISOString(),
    };
  }

  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  console.log(`Done: ${OUT}\nRebuild the extension (pnpm build) so the files are packed with it.`);
}

// Run as a script (also from install.sh's copy); imported by the test that compares it with the extension's list
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
