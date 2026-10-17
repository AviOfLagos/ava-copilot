/**
 * The local voice models the extension can download on first use: every file from a pinned revision, checked
 * against a pinned SHA-256 before it counts. The same sources and sums as `scripts/voice-models-setup.mjs` and
 * `scripts/wake-word-setup.mjs` (those stay self-contained, because `site/public/install.sh --with-voices` fetches
 * them on their own); `__tests__/catalog.test.ts` fails when the two lists drift apart.
 *
 * No imports: workers and the background read this too.
 */

export type VoiceModelComponentId = 'kitten' | 'kokoro' | 'moonshine-tiny' | 'moonshine-base' | 'whisper-base' | 'vosk';

export interface CatalogFile {
  // Where it is kept, inside the component's folder (the same layout as the packed voice/<component>/ folder)
  path: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface CatalogComponent {
  id: VoiceModelComponentId;
  files: CatalogFile[];
  // Turned into what the runtime reads after the download is checked: KittenTTS's voices.npz into one raw file
  // per voice, the Vosk model's zip into the tar.gz Vosk reads plus its word list
  unpack?: 'kitten-voices' | 'vosk-model';
}

export type VoiceModelCatalog = Record<VoiceModelComponentId, CatalogComponent>;

const HF = 'https://huggingface.co';
const KITTEN_REPO = 'KittenML/kitten-tts-nano-0.8-int8@84781d74e29ee25217551556398b42f80593a813';
const MOONSHINE_TINY = 'onnx-community/moonshine-tiny-ONNX@a6da1241cd305dcd64eab1edbd615f2bb9aabb95';
const MOONSHINE_BASE = 'onnx-community/moonshine-base-ONNX@b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad';
const WHISPER_BASE = 'onnx-community/whisper-base@1846881b6b3a3024392c1eea3ad983695bc23925';
const KOKORO = 'onnx-community/Kokoro-82M-v1.0-ONNX@1939ad2a8e416c0acfeecc08a694d14ef25f2231';

// The Vosk model the wake word and Vosk dictation use; the top folder inside its archive
export const VOSK_MODEL_DIR = 'vosk-model-small-en-us-0.15';

/** A file of a Hugging Face repo at a pinned revision. */
function hf(repoAtRevision: string, source: string, bytes: number, sha256: string, path = source): CatalogFile {
  const [repo, revision] = repoAtRevision.split('@');
  return { path, url: `${HF}/${repo}/resolve/${revision}/${source}`, bytes, sha256 };
}

// Shared by both Moonshine sizes (same tokenizer and preprocessing)
const moonshineText = (repo: string): CatalogFile[] => [
  hf(repo, 'generation_config.json', 147, 'f9b3f711b57be7def2e50a8942f64f36ee0a55fad5b84ff93a687b6c5bcc1d44'),
  hf(repo, 'preprocessor_config.json', 128, 'fa43a7017ef85cd1d0fba0d9aae77c8adb16990ae6f11115631f41ec5d8aa679'),
  hf(repo, 'special_tokens_map.json', 3, 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356'),
  hf(repo, 'tokenizer.json', 3761754, '7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f'),
  hf(repo, 'tokenizer_config.json', 135735, 'edaee394565d428ea98a663ae7209cdcfeefc5585c42d7a570ff7c986df2cd15'),
];

const KOKORO_VOICE_SUMS: Record<string, string> = {
  af_heart: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  af_bella: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  af_nicole: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
  af_sarah: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a',
  am_michael: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  am_fenrir: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43',
  bf_emma: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  bm_george: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
};

export const VOICE_MODEL_CATALOG: VoiceModelCatalog = {
  kitten: {
    id: 'kitten',
    unpack: 'kitten-voices',
    files: [
      hf(
        KITTEN_REPO,
        'config.json',
        688,
        'b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64',
        'kitten.json',
      ),
      hf(
        KITTEN_REPO,
        'kitten_tts_nano_v0_8.onnx',
        24369971,
        'f7b0afcbee92870b32b8e0276d855b954dc25470c9f051b376ac7eee537c76fc',
        'onnx/model_quantized.onnx',
      ),
      hf(KITTEN_REPO, 'voices.npz', 3278902, '8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f'),
    ],
  },
  'moonshine-tiny': {
    id: 'moonshine-tiny',
    files: [
      hf(MOONSHINE_TINY, 'config.json', 921, '558e1e02069137c796ace1e50c48d8fe451f04a295929138e6bea885517f0edb'),
      ...moonshineText(MOONSHINE_TINY),
      hf(
        MOONSHINE_TINY,
        'onnx/encoder_model_quantized.onnx',
        7937661,
        'c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a',
      ),
      hf(
        MOONSHINE_TINY,
        'onnx/decoder_model_merged_quantized.onnx',
        20243286,
        'eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367',
      ),
    ],
  },
  'moonshine-base': {
    id: 'moonshine-base',
    files: [
      hf(MOONSHINE_BASE, 'config.json', 922, 'fab7241d1e9fc6c2370c4c6dfb5da79bb54d67ed9ab6b507ac51d29d2abe01d1'),
      ...moonshineText(MOONSHINE_BASE),
      hf(
        MOONSHINE_BASE,
        'onnx/encoder_model_quantized.onnx',
        20513063,
        '1dd9ab0a7f987113d30affcba5a068d11c8f90fa0223caa3e491ade431ad9751',
      ),
      hf(
        MOONSHINE_BASE,
        'onnx/decoder_model_merged_quantized.onnx',
        42498870,
        'cc9f3cd6698a369c6008b41aa60aa3fb3322e7f03c9bdf19d8e6b7200afca4f3',
      ),
    ],
  },
  'whisper-base': {
    id: 'whisper-base',
    files: [
      hf(WHISPER_BASE, 'config.json', 2243, 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b'),
      hf(
        WHISPER_BASE,
        'generation_config.json',
        3832,
        '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0',
      ),
      hf(
        WHISPER_BASE,
        'preprocessor_config.json',
        339,
        'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
      ),
      hf(
        WHISPER_BASE,
        'special_tokens_map.json',
        2194,
        'e67ae3a0aaa99abcd9f187138e12db1f65c16a14761c50ef10eef2c174a7a691',
      ),
      hf(WHISPER_BASE, 'tokenizer.json', 2480466, '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566'),
      hf(
        WHISPER_BASE,
        'tokenizer_config.json',
        282682,
        '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573',
      ),
      hf(
        WHISPER_BASE,
        'onnx/encoder_model_quantized.onnx',
        23201314,
        '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46',
      ),
      hf(
        WHISPER_BASE,
        'onnx/decoder_model_merged_quantized.onnx',
        53693315,
        'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
      ),
    ],
  },
  kokoro: {
    id: 'kokoro',
    files: [
      hf(KOKORO, 'config.json', 44, 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f'),
      hf(KOKORO, 'tokenizer.json', 3497, '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34'),
      hf(KOKORO, 'tokenizer_config.json', 113, 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20'),
      hf(
        KOKORO,
        'onnx/model_quantized.onnx',
        92361116,
        'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
      ),
      ...Object.entries(KOKORO_VOICE_SUMS).map(([voice, sha256]) => hf(KOKORO, `voices/${voice}.bin`, 522240, sha256)),
    ],
  },
  vosk: {
    id: 'vosk',
    unpack: 'vosk-model',
    files: [
      {
        path: 'model.zip',
        url: `https://alphacephei.com/vosk/models/${VOSK_MODEL_DIR}.zip`,
        bytes: 41205931,
        sha256: '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498',
      },
    ],
  },
};

/** Bytes a component downloads (what the user is told before it starts). */
export function downloadBytes(component: CatalogComponent): number {
  return component.files.reduce((sum, file) => sum + file.bytes, 0);
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

/**
 * The catalog in use. A test may put its own on `globalThis.__nexVoiceModelsCatalog` (the E2E serves small files
 * from a local server); it is honoured only when every file comes from this computer (127.0.0.1 or localhost), so
 * it can never point the extension at another host.
 */
export function activeCatalog(scope: unknown = globalThis): VoiceModelCatalog {
  const override = (scope as { __nexVoiceModelsCatalog?: unknown } | null)?.__nexVoiceModelsCatalog;
  if (!override || typeof override !== 'object') return VOICE_MODEL_CATALOG;
  const components = Object.values(override as Record<string, CatalogComponent>);
  const local = components.every(
    component =>
      Array.isArray(component?.files) &&
      component.files.every(
        file =>
          typeof file?.url === 'string' &&
          LOOPBACK.test(file.url) &&
          /^[0-9a-f]{64}$/.test(file.sha256) &&
          Number.isFinite(file.bytes),
      ),
  );
  return local ? { ...VOICE_MODEL_CATALOG, ...(override as Partial<VoiceModelCatalog>) } : VOICE_MODEL_CATALOG;
}
