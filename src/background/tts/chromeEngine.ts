import { chunkText } from './chunk';
import type { SpeakOptions } from './types';

/**
 * Engine A, the default: the operating system's own voices, spoken straight from the background with
 * `chrome.tts`. Every chunk is queued up front with `enqueue: true` (bar the first, which clears
 * anything already speaking) because Chrome's own TTS queue lives outside the worker - a queue held
 * in the worker itself would die the moment it goes idle between chunks.
 */
export function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve();
    };

    chunks.forEach((chunk, index) => {
      const last = index === chunks.length - 1;
      chrome.tts.speak(chunk, {
        enqueue: index > 0,
        voiceName: options.voice || undefined,
        rate: options.rate ?? 1,
        onEvent: event => {
          if (event.type === 'error') finish(new Error(event.errorMessage || 'Speech failed'));
          else if (event.type === 'interrupted' || event.type === 'cancelled') finish();
          else if (event.type === 'end' && last) finish();
        },
      });
    });
  });
}

export async function stop(): Promise<void> {
  chrome.tts.stop();
}

export function speaking(): Promise<boolean> {
  return new Promise(resolve => chrome.tts.isSpeaking(resolve));
}

export function listVoices(): Promise<chrome.tts.TtsVoice[]> {
  return new Promise(resolve => chrome.tts.getVoices(resolve));
}
