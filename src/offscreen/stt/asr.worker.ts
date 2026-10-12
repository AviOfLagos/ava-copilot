/// <reference lib="webworker" />
/**
 * Speech recognition on the device, in a worker of the offscreen document: Moonshine (tiny or base) or Whisper
 * base through transformers.js. On the GPU (WebGPU) when there is one and the float weights were installed
 * (`voice-models-setup.mjs --webgpu`), else on the CPU (WebAssembly) with the 8-bit weights. Audio in is 16 kHz
 * mono; nothing leaves the worker but the text.
 */
import { env, pipeline } from '@huggingface/transformers';
import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { AsrModelId, FromAsrWorker, ToAsrWorker } from './protocol';
import { configureTransformers, hasWebGpu } from './runtime';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let recogniser: Promise<{ asr: AutomaticSpeechRecognitionPipeline; model: AsrModelId }> | null = null;
let queue: Promise<void> = Promise.resolve();

const post = (message: FromAsrWorker) => scope.postMessage(message);

async function load(
  model: AsrModelId,
  gpu: boolean,
): Promise<{ asr: AutomaticSpeechRecognitionPipeline; device: 'webgpu' | 'wasm' }> {
  if (gpu && (await hasWebGpu())) {
    try {
      const asr = await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      });
      return { asr, device: 'webgpu' };
    } catch {
      // A GPU that cannot run it: the CPU can
    }
  }
  const asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8' });
  return { asr, device: 'wasm' };
}

async function transcribe(id: number, audio: Float32Array): Promise<void> {
  if (!recogniser) throw new Error('No speech model is loaded');
  const { asr, model } = await recogniser;
  const started = performance.now();
  const options = model === 'whisper-base' ? { language: 'en', task: 'transcribe' } : {};
  const output = await asr(audio, options as never);
  const text = (Array.isArray(output) ? output.map(item => item.text).join(' ') : output.text).trim();
  post({ type: 'text', id, text, ms: performance.now() - started });
}

scope.onmessage = (event: MessageEvent<ToAsrWorker>) => {
  const message = event.data;
  if (message.type === 'load') {
    configureTransformers(env as never, message.base);
    const started = performance.now();
    const loading = load(message.model, message.webgpu);
    recogniser = loading.then(({ asr }) => ({ asr, model: message.model }));
    recogniser.catch(() => {});
    loading.then(
      ({ device }) => post({ type: 'loaded', device, ms: performance.now() - started }),
      error => {
        recogniser = null;
        post({ type: 'error', message: String(error instanceof Error ? error.message : error) });
      },
    );
    return;
  }
  queue = queue.then(() =>
    transcribe(message.id, message.audio).catch(error =>
      post({ type: 'error', id: message.id, message: String(error instanceof Error ? error.message : error) }),
    ),
  );
};
