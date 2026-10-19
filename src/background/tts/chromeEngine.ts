import { chunkText } from './chunk';
import type { SpeakOptions } from './types';
import { pickSystemVoice } from '@extension/storage';

// The system voice the last line was spoken with (null: the default), for the voice status and tests
let lastVoice: string | null = null;
export const lastSystemVoice = (): string | null => lastVoice;

async function installedNames(): Promise<string[]> {
  try {
    return (await listVoices()).map(voice => voice.voiceName ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Engine A, the default: the operating system's own voices, spoken straight from the background with
 * `chrome.tts`. Every chunk is queued up front with `enqueue: true` (bar the first, which clears
 * anything already speaking) because Chrome's own TTS queue lives outside the worker - a queue held
 * in the worker itself would die the moment it goes idle between chunks.
 */
export async function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return;
  // A personality's or agent's system voice may name several (the first installed is used), or one this computer
  // lacks: then the system default speaks rather than nothing
  const voice = options.voice ? pickSystemVoice(options.voice, await installedNames()) : undefined;
  lastVoice = voice ?? null;

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
        voiceName: voice,
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
