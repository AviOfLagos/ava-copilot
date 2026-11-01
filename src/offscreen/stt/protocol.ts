/** Messages between the offscreen document and the speech recognition worker (Moonshine, Whisper). */

export type AsrModelId = 'moonshine-tiny' | 'moonshine-base' | 'whisper-base';

export type ToAsrWorker =
  | { type: 'load'; model: AsrModelId; base: string; webgpu: boolean }
  | { type: 'transcribe'; id: number; audio: Float32Array; language?: string };

export type FromAsrWorker =
  | { type: 'loaded'; device: 'webgpu' | 'wasm'; ms: number }
  | { type: 'text'; id: number; text: string; ms: number }
  | { type: 'error'; id?: number; message: string };
