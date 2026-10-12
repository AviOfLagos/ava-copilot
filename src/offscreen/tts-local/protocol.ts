/** Messages between the offscreen document and the local voice worker. */

export type LocalVoiceEngine = 'kitten' | 'kokoro';

export type ToTtsWorker =
  | { type: 'load'; engine: LocalVoiceEngine; base: string }
  | { type: 'speak'; id: number; engine: LocalVoiceEngine; text: string; voice: string; speed: number }
  | { type: 'cancel'; id: number };

export type FromTtsWorker =
  | { type: 'loaded'; engine: LocalVoiceEngine; ms: number }
  // One sentence of speech, mono float samples
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number; ms: number }
  | { type: 'done'; id: number }
  | { type: 'error'; id?: number; message: string };
