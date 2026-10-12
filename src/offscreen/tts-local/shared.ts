import { LocalTts } from './local-tts';

let instance: LocalTts | null = null;

/** The one local voice of the offscreen document, shared by read-aloud, the settings test and conversations. */
export function localTts(): LocalTts {
  instance ??= new LocalTts();
  return instance;
}
