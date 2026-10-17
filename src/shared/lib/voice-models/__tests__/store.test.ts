import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { downloadedModels, downloadModels, MODELS_DIR, openModelFile, READY_FILE, removeModel } from '../store';
import type { StoreDeps } from '../store';
import { createModelFetch, modelLocation } from '../resolve';
import { installedModels } from '../installed';
import { activeCatalog, VOICE_MODEL_CATALOG, VOSK_MODEL_DIR } from '../catalog';
import { readSymbolTable } from '../unpack';
import { FakeDirectoryHandle, rootOf } from './fakeOpfs';
import { bytesOf, fakeServer, makeNpy, makeZip, servedComponent, sha256 } from './helpers';

const noWait = async () => {};

function setup(
  files: Record<string, Uint8Array>,
  id: 'moonshine-tiny' | 'kitten' | 'vosk' = 'moonshine-tiny',
  unpack?: 'kitten-voices' | 'vosk-model',
) {
  const fake = new FakeDirectoryHandle();
  const { served, catalog, component } = servedComponent(id, files, unpack);
  const server = fakeServer(served);
  const deps: StoreDeps = { root: rootOf(fake), fetch: server.fetch, catalog, lock: work => work(), sleep: noWait };
  return { fake, server, deps, component, dir: () => fake.dirs.get(MODELS_DIR)?.dirs.get(id) };
}

const FILES = {
  'config.json': new TextEncoder().encode('{"model_type":"moonshine"}'),
  'onnx/encoder_model_quantized.onnx': bytesOf(5000),
};

describe('downloadModels', () => {
  it('downloads every file, checks it, then marks the component ready', async () => {
    const { deps, dir } = setup(FILES);
    const progress: number[] = [];
    await downloadModels(['moonshine-tiny'], { onProgress: p => progress.push(p.received) }, deps);
    expect(dir()?.read('onnx/encoder_model_quantized.onnx')).toEqual(FILES['onnx/encoder_model_quantized.onnx']);
    expect(dir()?.read('onnx/encoder_model_quantized.onnx.part')).toBeUndefined();
    expect(dir()?.files.has(READY_FILE)).toBe(true);
    expect(progress.at(-1)).toBe(5000 + FILES['config.json'].length);
    expect(await downloadedModels(deps)).toEqual({ 'moonshine-tiny': { bytes: 5026 } });
    const file = await openModelFile('moonshine-tiny', 'config.json', deps);
    expect(await file?.text()).toBe('{"model_type":"moonshine"}');
  });

  it('refuses a file whose checksum does not match, keeps nothing of it and marks nothing ready', async () => {
    const { deps, dir, server, component } = setup(FILES);
    const onnx = component.files[1];
    server.tamper.set(onnx.url, bytesOf(5000, 2));
    await expect(downloadModels(['moonshine-tiny'], {}, deps)).rejects.toMatchObject({ kind: 'invalid' });
    expect(dir()?.read('onnx/encoder_model_quantized.onnx')).toBeUndefined();
    expect(dir()?.read('onnx/encoder_model_quantized.onnx.part')).toBeUndefined();
    expect(dir()?.files.has(READY_FILE)).toBe(false);
    expect(await downloadedModels(deps)).toEqual({});
    expect(await openModelFile('moonshine-tiny', 'config.json', deps)).toBeNull();
    // Not retried: a wrong file is not a lost connection
    expect(server.requests.filter(request => request.url === onnx.url)).toHaveLength(1);
  });

  it('resumes a file cut off mid-download with a Range request, fetching each byte once', async () => {
    const { deps, dir, server, component } = setup(FILES);
    server.cutAfter.push(Number.MAX_SAFE_INTEGER, 2100);
    await downloadModels(['moonshine-tiny'], {}, deps);
    const onnx = component.files[1];
    const asked = server.requests.filter(request => request.url === onnx.url);
    expect(asked.map(request => request.range)).toEqual([null, 'bytes=2100-']);
    expect(dir()?.read(onnx.path)).toEqual(FILES['onnx/encoder_model_quantized.onnx']);
    expect(dir()?.files.has(READY_FILE)).toBe(true);
  });

  it('keeps a stopped download as a partial file, not ready, and the next one picks it up', async () => {
    const { deps, dir, server, component } = setup(FILES);
    const onnx = component.files[1];
    const controller = new AbortController();
    server.onChunk = sent => {
      if (sent >= 3500 && server.requests.at(-1)?.url === onnx.url) controller.abort();
    };
    await expect(downloadModels(['moonshine-tiny'], { signal: controller.signal }, deps)).rejects.toMatchObject({
      kind: 'cancelled',
    });
    const partial = dir()?.read(`${onnx.path}.part`);
    expect(partial?.length).toBeGreaterThan(0);
    expect(partial?.length).toBeLessThan(5000);
    expect(dir()?.read(onnx.path)).toBeUndefined();
    expect(dir()?.files.has(READY_FILE)).toBe(false);
    expect(await downloadedModels(deps)).toEqual({});

    server.onChunk = undefined;
    await downloadModels(['moonshine-tiny'], {}, deps);
    expect(server.requests.at(-1)?.range).toBe(`bytes=${partial?.length}-`);
    expect(dir()?.read(onnx.path)).toEqual(FILES['onnx/encoder_model_quantized.onnx']);
    expect(await downloadedModels(deps)).toHaveProperty('moonshine-tiny');
  });

  it('starts a file over when the server ignores the Range request', async () => {
    const { deps, dir, server, component, fake } = setup(FILES);
    const onnx = component.files[1];
    fake.put(`${MODELS_DIR}/moonshine-tiny/${onnx.path}.part`, bytesOf(900, 9));
    const plain = server.fetch;
    server.fetch = ((input: RequestInfo | URL) => plain(input)) as typeof fetch; // drops the Range header
    await downloadModels(['moonshine-tiny'], {}, { ...deps, fetch: server.fetch });
    expect(dir()?.read(onnx.path)).toEqual(FILES['onnx/encoder_model_quantized.onnx']);
  });

  it('does nothing for a component already downloaded, and downloads again after a new pinned revision', async () => {
    const { deps, server, component } = setup(FILES);
    await downloadModels(['moonshine-tiny'], {}, deps);
    const count = server.requests.length;
    await downloadModels(['moonshine-tiny'], {}, deps);
    expect(server.requests.length).toBe(count);

    const changed = {
      ...component,
      files: [component.files[0], { ...component.files[1], sha256: sha256(bytesOf(5000, 3)) }],
    };
    server.tamper.set(component.files[1].url, bytesOf(5000, 3));
    await downloadModels(['moonshine-tiny'], {}, { ...deps, catalog: { ...deps.catalog!, 'moonshine-tiny': changed } });
    expect(server.requests.length).toBe(count + 2);
  });

  it('removes a downloaded component', async () => {
    const { deps } = setup(FILES);
    await downloadModels(['moonshine-tiny'], {}, deps);
    await removeModel('moonshine-tiny', deps);
    expect(await downloadedModels(deps)).toEqual({});
  });
});

describe('unpacking', () => {
  it("turns KittenTTS's voices.npz into one raw file per voice and the index the worker reads", async () => {
    const bella = Float32Array.from({ length: 6 }, (_, i) => i / 10);
    const jasper = Float32Array.from({ length: 6 }, (_, i) => -i);
    const npz = makeZip([
      { name: 'expr-voice-2-f.npy', data: makeNpy([3, 2], bella), deflate: true },
      { name: 'expr-voice-2-m.npy', data: makeNpy([3, 2], jasper) },
    ]);
    const kittenJson = JSON.stringify({
      voice_aliases: { Bella: 'expr-voice-2-f', Jasper: 'expr-voice-2-m' },
      speed_priors: { 'expr-voice-2-f': 0.8 },
    });
    const { deps, dir } = setup(
      { 'kitten.json': new TextEncoder().encode(kittenJson), 'voices.npz': npz },
      'kitten',
      'kitten-voices',
    );
    await downloadModels(['kitten'], {}, deps);
    expect(new Float32Array(dir()!.read('voices/expr-voice-2-f.bin')!.slice().buffer)).toEqual(bella);
    expect(new Float32Array(dir()!.read('voices/expr-voice-2-m.bin')!.slice().buffer)).toEqual(jasper);
    expect(JSON.parse(new TextDecoder().decode(dir()!.read('voices.json')))).toEqual({
      sampleRate: 24000,
      styles: 3,
      styleDim: 2,
      voices: { Bella: { key: 'expr-voice-2-f', speed: 0.8 }, Jasper: { key: 'expr-voice-2-m', speed: 1 } },
    });
    expect(new TextDecoder().decode(dir()!.read('config.json'))).toContain('style_text_to_speech_2');
    // The archive is not kept once unpacked
    expect(dir()!.read('voices.npz')).toBeUndefined();
    expect(await downloadedModels(deps)).toHaveProperty('kitten');
  });

  it("turns the Vosk model's zip into the tar.gz Vosk reads and the word list", async () => {
    const symbols = symbolTable(['<eps>', 'hey', 'ava', 'nova', '#0', '[unk]']);
    const graph = new Uint8Array([1, 2, 3, ...symbols, 9, 9]);
    const zip = makeZip([
      { name: `${VOSK_MODEL_DIR}/`, data: new Uint8Array() },
      { name: `${VOSK_MODEL_DIR}/am/final.mdl`, data: bytesOf(1300), deflate: true },
      { name: `${VOSK_MODEL_DIR}/graph/Gr.fst`, data: graph },
      { name: `__MACOSX/${VOSK_MODEL_DIR}/._final.mdl`, data: bytesOf(5) },
    ]);
    const { deps, dir } = setup({ 'model.zip': zip }, 'vosk', 'vosk-model');
    await downloadModels(['vosk'], {}, deps);
    expect(new TextDecoder().decode(dir()!.read('words.txt'))).toBe('hey\nava\nnova\n');
    const tar = gunzipSync(dir()!.read('model.tar.gz')!);
    const names: string[] = [];
    for (let at = 0; at + 512 <= tar.length;) {
      const name = tar
        .subarray(at, at + 100)
        .toString('utf8')
        .replace(/\0.*$/s, '');
      if (!name) break;
      const size = parseInt(tar.subarray(at + 124, at + 136).toString('utf8'), 8);
      names.push(`${tar[at + 156] === 0x35 ? 'd' : 'f'} ${name}`);
      if (name.endsWith('final.mdl'))
        expect(new Uint8Array(tar.subarray(at + 512, at + 512 + size))).toEqual(bytesOf(1300));
      at += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual([
      `d ${VOSK_MODEL_DIR}/`,
      `d ${VOSK_MODEL_DIR}/am/`,
      `d ${VOSK_MODEL_DIR}/graph/`,
      `f ${VOSK_MODEL_DIR}/am/final.mdl`,
      `f ${VOSK_MODEL_DIR}/graph/Gr.fst`,
    ]);
    expect(dir()!.read('model.zip')).toBeUndefined();
  });

  it('reads the words of an OpenFst symbol table', () => {
    expect(readSymbolTable(symbolTable(['<eps>', 'hello', '!SIL', 'world']))).toEqual(['hello', 'world']);
  });
});

/** An OpenFst symbol table as Gr.fst embeds it. */
function symbolTable(words: string[]): Uint8Array {
  const parts: number[] = [];
  const int32 = (value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, value, true);
    parts.push(...bytes);
  };
  const int64 = (value: number) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
    parts.push(...bytes);
  };
  int32(2125658996);
  const name = new TextEncoder().encode('words');
  int32(name.length);
  parts.push(...name);
  int64(words.length);
  int64(words.length);
  words.forEach((word, key) => {
    const bytes = new TextEncoder().encode(word);
    int32(bytes.length);
    parts.push(...bytes);
    int64(key);
  });
  return new Uint8Array(parts);
}

describe('where the runtimes read a model file', () => {
  const base = 'chrome-extension://abc/';

  it('maps packed model URLs to their component and file', () => {
    expect(modelLocation(`${base}voice/kitten/onnx/model_quantized.onnx`, base)).toEqual({
      id: 'kitten',
      path: 'onnx/model_quantized.onnx',
    });
    expect(modelLocation(`${base}wake/model.tar.gz`, base)).toEqual({ id: 'vosk', path: 'model.tar.gz' });
    expect(modelLocation(`${base}wake/words.txt`, base)).toEqual({ id: 'vosk', path: 'words.txt' });
    expect(modelLocation(`${base}voice/manifest.json`, base)).toBeNull();
    expect(modelLocation(`${base}voice/other/x`, base)).toBeNull();
    expect(modelLocation(`${base}vosk/vosk-worker.js`, base)).toBeNull();
    expect(modelLocation('https://huggingface.co/voice/kitten/x', base)).toBeNull();
  });

  it('reads the downloaded copy first, then the packed file, else answers 404 (not downloaded)', async () => {
    const { deps } = setup(FILES);
    const packed: string[] = [];
    let packedOk = true;
    const modelFetch = createModelFetch({
      base,
      open: (id, path) => openModelFile(id, path, deps),
      fetch: (async (input: RequestInfo | URL) => {
        packed.push(String(input));
        if (!packedOk) throw new TypeError('Failed to fetch');
        return new Response('packed');
      }) as typeof fetch,
    });
    const url = `${base}voice/moonshine-tiny/config.json`;

    // Not downloaded: the packed file (a dev build with public/voice)
    expect(await (await modelFetch(url)).text()).toBe('packed');
    // Neither: 404, which transformers.js reports as a missing file
    packedOk = false;
    expect((await modelFetch(url)).status).toBe(404);
    // Downloaded: the copy in OPFS, without asking the package
    await downloadModels(['moonshine-tiny'], {}, deps);
    packed.length = 0;
    const response = await modelFetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"model_type":"moonshine"}');
    expect(response.headers.get('content-length')).toBe('26');
    expect(packed).toEqual([]);
    // Other URLs are untouched
    packedOk = true;
    expect(await (await modelFetch('https://example.com/a')).text()).toBe('packed');
  });

  it('does not serve a component that is only partly downloaded', async () => {
    const { deps, server, dir } = setup(FILES);
    // config.json arrives whole; the model is cut off on every try
    server.cutAfter.push(Number.MAX_SAFE_INTEGER, 700, 700, 700, 700);
    await expect(downloadModels(['moonshine-tiny'], {}, deps)).rejects.toMatchObject({ kind: 'network' });
    expect(dir()?.read('config.json')).toBeDefined();
    expect(await openModelFile('moonshine-tiny', 'config.json', deps)).toBeNull();
    expect(await downloadedModels(deps)).toEqual({});
  });

  it('lists packed and downloaded models together', async () => {
    const { deps } = setup(FILES);
    await downloadModels(['moonshine-tiny'], {}, deps);
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).endsWith('voice/manifest.json')
        ? Response.json({ components: { kitten: { bytes: 28 }, 'moonshine-tiny': { bytes: 32, webgpu: true } } })
        : new Response(null, { status: 404 })) as typeof fetch;
    expect(await installedModels({ fetcher, base, store: deps })).toEqual({
      kitten: { bytes: 28 },
      'moonshine-tiny': { bytes: 5026, webgpu: true, downloaded: true },
    });
  });
});

describe('activeCatalog', () => {
  it('takes a test catalog only when every file comes from this computer', () => {
    const local = { 'moonshine-tiny': servedComponent('moonshine-tiny', FILES).component };
    expect(activeCatalog({ __nexVoiceModelsCatalog: local })['moonshine-tiny']).toBe(local['moonshine-tiny']);
    const remote = {
      'moonshine-tiny': {
        ...local['moonshine-tiny'],
        files: local['moonshine-tiny'].files.map(file => ({ ...file, url: 'https://evil.example/x' })),
      },
    };
    expect(activeCatalog({ __nexVoiceModelsCatalog: remote })).toBe(VOICE_MODEL_CATALOG);
    expect(activeCatalog({})).toBe(VOICE_MODEL_CATALOG);
  });
});
