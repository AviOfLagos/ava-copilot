import type { AsrModelId, FromAsrWorker, ToAsrWorker } from './protocol';
import { VoskDictation } from './vosk';

/** A recogniser on the device: load once, then one utterance in, its words out. */
export interface SttEngine {
  load(): Promise<SttLoadInfo>;
  transcribe(audio: Float32Array): Promise<string>;
  dispose(): void;
}

export interface SttLoadInfo {
  device: 'webgpu' | 'wasm';
  ms: number;
}

export type LocalSttEngine = 'moonshine' | 'whisper' | 'vosk';

export interface SttConfig {
  engine: LocalSttEngine;
  // The model folder in voice/ (Moonshine and Whisper)
  model?: AsrModelId;
  // Moonshine's float weights for the GPU are installed
  webgpu?: boolean;
}

/** Moonshine or Whisper, through transformers.js in a worker. */
export class TransformersStt implements SttEngine {
  private worker: Worker | null = null;
  private loading: Promise<SttLoadInfo> | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly model: AsrModelId,
    private readonly webgpu = false,
    private readonly createWorker: () => Worker = () =>
      new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' }),
    private readonly modelBase = chrome.runtime.getURL('voice/'),
  ) {}

  load(): Promise<SttLoadInfo> {
    this.loading ??= new Promise<SttLoadInfo>((resolve, reject) => {
      const worker = this.createWorker();
      this.worker = worker;
      worker.onmessage = event => {
        const message = event.data as FromAsrWorker;
        if (message.type === 'loaded') resolve({ device: message.device, ms: Math.round(message.ms) });
        else if (message.type === 'text') this.settle(message.id, message.text);
        else if (message.id !== undefined) this.settle(message.id, new Error(message.message));
        else reject(new Error(message.message));
      };
      worker.onerror = event => {
        const error = new Error(event.message || 'The speech recognition worker failed');
        reject(error);
        for (const id of [...this.waiting.keys()]) this.settle(id, error);
      };
      worker.postMessage({
        type: 'load',
        model: this.model,
        base: this.modelBase,
        webgpu: this.webgpu,
      } satisfies ToAsrWorker);
    }).catch(error => {
      this.dispose();
      throw error;
    });
    return this.loading;
  }

  async transcribe(audio: Float32Array): Promise<string> {
    await this.load();
    const id = this.nextId++;
    const text = new Promise<string>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    const copy = new Float32Array(audio);
    this.worker!.postMessage({ type: 'transcribe', id, audio: copy } satisfies ToAsrWorker, [copy.buffer]);
    return text;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
    for (const id of [...this.waiting.keys()]) this.settle(id, new Error('Stopped'));
  }

  private settle(id: number, result: string | Error): void {
    const waiter = this.waiting.get(id);
    if (!waiter) return;
    this.waiting.delete(id);
    if (result instanceof Error) waiter.reject(result);
    else waiter.resolve(result);
  }
}

/** Vosk, behind the same shape. */
class VoskStt implements SttEngine {
  private readonly vosk = new VoskDictation();

  async load(): Promise<SttLoadInfo> {
    const started = performance.now();
    await this.vosk.load();
    return { device: 'wasm', ms: Math.round(performance.now() - started) };
  }

  transcribe(audio: Float32Array): Promise<string> {
    return this.vosk.transcribe(audio);
  }

  dispose(): void {
    this.vosk.dispose();
  }
}

export const STT_STALLED = 'Speech recognition stopped responding, so it was restarted. Say that again.';

/** How long one utterance may take to write down: generous (a slow processor, a first load), never forever. */
export function transcribeLimitMs(audio: Float32Array, sampleRate = 16_000): number {
  return Math.max(20_000, Math.round((audio.length / sampleRate) * 1000 * 3));
}

/**
 * A recogniser that cannot hang the conversation. A worker can stall (the graphics card stops answering, the worker
 * dies without an error): its answer would never come, and everything after it would wait forever, even in the
 * next conversation, which gets the same loaded engine from the pool. Past the limit the worker is thrown away; the
 * next utterance loads a fresh one.
 */
export function withTimeLimit(engine: SttEngine, limitFor = transcribeLimitMs): SttEngine {
  return {
    load: () => engine.load(),
    dispose: () => engine.dispose(),
    transcribe(audio) {
      const limit = limitFor(audio);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          engine.dispose();
          reject(new Error(STT_STALLED));
        }, limit);
      });
      return Promise.race([engine.transcribe(audio), stalled]).finally(() => clearTimeout(timer));
    },
  };
}

export function createSttEngine(config: SttConfig): SttEngine {
  if (config.engine === 'vosk') return withTimeLimit(new VoskStt());
  const model = config.model ?? (config.engine === 'whisper' ? 'whisper-base' : 'moonshine-tiny');
  return withTimeLimit(new TransformersStt(model, config.webgpu ?? false));
}
