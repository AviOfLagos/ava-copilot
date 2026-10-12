/// <reference lib="webworker" />
/**
 * The local voices, in a worker of the offscreen document: KittenTTS nano and Kokoro, both StyleTTS 2 models run
 * by transformers.js on onnxruntime-web (WebAssembly). Text becomes phonemes with eSpeak NG (the `phonemizer`
 * WebAssembly build inside kitten-tts-js), then token ids, then speech, one sentence at a time so the first
 * sentence plays while the next is made. Model files come from the extension's own `voice/` folder.
 */
import { AutoTokenizer, env, StyleTextToSpeech2Model, Tensor } from '@huggingface/transformers';
import { phonemize, TextCleaner, TextPreprocessor } from 'kitten-tts-js';
import { configureTransformers } from '../stt/runtime';
import type { FromTtsWorker, LocalVoiceEngine, ToTtsWorker } from './protocol';
import {
  basicEnglishTokenize,
  ensurePunctuation,
  kokoroPhonemes,
  splitSentences,
  styleRow,
  trimSilence,
  trimTail,
} from './text';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const SAMPLE_RATE = 24_000;
const STYLE_DIM = 256;

type Inputs = Record<string, Tensor>;
type VoiceModel = ((inputs: Inputs) => Promise<Record<string, Tensor>>) & { dispose(): Promise<unknown> };

interface KittenVoices {
  styles: number;
  styleDim: number;
  voices: Record<string, { key: string; speed: number }>;
}

interface Loaded {
  model: VoiceModel;
  // Phonemes → token ids
  tokenize: (phonemes: string) => number[];
  kitten?: KittenVoices;
}

let base = '';
const loaded = new Map<LocalVoiceEngine, Promise<Loaded>>();
const voiceCache = new Map<string, Promise<Float32Array>>();
const cancelled = new Set<number>();
// Numbers, money, times and the like become words; punctuation stays, for the pauses (kitten-tts-js's own setting,
// which its type declarations leave out)
const Preprocessor = TextPreprocessor as unknown as new (options: {
  remove_punctuation: boolean;
}) => InstanceType<typeof TextPreprocessor>;
const preprocessor = new Preprocessor({ remove_punctuation: false });
const kittenCleaner = new TextCleaner();
// Requests run one at a time, in order
let queue: Promise<void> = Promise.resolve();

const post = (message: FromTtsWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${path} is missing (HTTP ${response.status})`);
  return (await response.json()) as T;
}

/** A voice's style table: raw little-endian float32 (KittenTTS 400 × 256, Kokoro 510 × 256). */
function voiceTable(path: string): Promise<Float32Array> {
  let table = voiceCache.get(path);
  if (!table) {
    table = fetch(`${base}${path}`).then(async response => {
      if (!response.ok) throw new Error(`The voice ${path} is not installed`);
      return new Float32Array(await response.arrayBuffer());
    });
    voiceCache.set(path, table);
    table.catch(() => voiceCache.delete(path));
  }
  return table;
}

async function load(engine: LocalVoiceEngine): Promise<Loaded> {
  const model = (await StyleTextToSpeech2Model.from_pretrained(engine, {
    dtype: 'q8',
    device: 'wasm',
  })) as unknown as VoiceModel;
  if (engine === 'kitten') {
    const kitten = await fetchJson<KittenVoices>('kitten/voices.json');
    return { model, kitten, tokenize: phonemes => kittenCleaner.clean(phonemes) };
  }
  const tokenizer = await AutoTokenizer.from_pretrained('kokoro');
  return {
    model,
    tokenize: phonemes => {
      const { input_ids } = tokenizer(phonemes, { truncation: true }) as { input_ids: Tensor };
      return Array.from(input_ids.data as BigInt64Array, Number);
    },
  };
}

function ensureLoaded(engine: LocalVoiceEngine): Promise<Loaded> {
  let model = loaded.get(engine);
  if (!model) {
    model = load(engine);
    loaded.set(engine, model);
    model.catch(() => loaded.delete(engine));
  }
  return model;
}

/** One sentence to speech. */
async function synthesize(
  engine: LocalVoiceEngine,
  model: Loaded,
  sentence: string,
  voice: string,
  speed: number,
): Promise<Float32Array> {
  const text = preprocessor.process(engine === 'kitten' ? ensurePunctuation(sentence) : sentence);
  const raw = await phonemize(text);
  let ids: number[];
  let style: Float32Array;
  let rate = speed;
  if (engine === 'kitten' && model.kitten) {
    const entry = model.kitten.voices[voice] ?? model.kitten.voices.Bella ?? Object.values(model.kitten.voices)[0];
    ids = model.tokenize(basicEnglishTokenize(raw).join(' '));
    style = styleRow(await voiceTable(`kitten/voices/${entry.key}.bin`), model.kitten.styleDim, ids.length);
    // KittenTTS's own speed for each voice, as its Python package applies it
    rate = speed * entry.speed;
  } else {
    ids = model.tokenize(kokoroPhonemes(raw));
    // Kokoro's row is the token count without the start and end tokens
    style = styleRow(
      await voiceTable(`kokoro/voices/${voice}.bin`),
      STYLE_DIM,
      Math.min(Math.max(ids.length - 2, 0), 509),
    );
  }
  const outputs = await model.model({
    input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    style: new Tensor('float32', style, [1, style.length]),
    speed: new Tensor('float32', new Float32Array([rate]), [1]),
  });
  const waveform = (outputs.waveform ?? Object.values(outputs)[0]) as Tensor;
  const samples = new Float32Array(waveform.data as Float32Array);
  return trimSilence(engine === 'kitten' ? trimTail(samples) : samples, SAMPLE_RATE);
}

async function speak(request: Extract<ToTtsWorker, { type: 'speak' }>): Promise<void> {
  const model = await ensureLoaded(request.engine);
  for (const sentence of splitSentences(request.text)) {
    if (cancelled.has(request.id)) break;
    const started = performance.now();
    const samples = await synthesize(request.engine, model, sentence, request.voice, request.speed);
    if (cancelled.has(request.id)) break;
    post({ type: 'audio', id: request.id, samples, sampleRate: SAMPLE_RATE, ms: performance.now() - started }, [
      samples.buffer,
    ]);
  }
  cancelled.delete(request.id);
  post({ type: 'done', id: request.id });
}

scope.onmessage = (event: MessageEvent<ToTtsWorker>) => {
  const message = event.data;
  switch (message.type) {
    case 'load': {
      if (!base) {
        base = message.base;
        configureTransformers(env as never, base);
      }
      const started = performance.now();
      ensureLoaded(message.engine).then(
        () => post({ type: 'loaded', engine: message.engine, ms: performance.now() - started }),
        error => post({ type: 'error', message: String(error instanceof Error ? error.message : error) }),
      );
      return;
    }
    case 'speak':
      queue = queue.then(() =>
        speak(message).catch(error =>
          post({ type: 'error', id: message.id, message: String(error instanceof Error ? error.message : error) }),
        ),
      );
      return;
    case 'cancel':
      cancelled.add(message.id);
      return;
  }
};
