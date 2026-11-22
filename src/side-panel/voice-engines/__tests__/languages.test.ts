import { describe, expect, it } from 'vitest';
import { languageNoteKey } from '../languages';

describe('what Settings says about the languages a recogniser hears', () => {
  it('says Moonshine and Vosk only understand English', () => {
    expect(languageNoteKey('moonshine')).toBe('voice_engine_stt_englishOnly');
    expect(languageNoteKey('vosk')).toBe('voice_engine_stt_englishOnly');
  });
  it('says Whisper hears other languages too, and says nothing for Gemini', () => {
    expect(languageNoteKey('whisper')).toBe('voice_engine_stt_whisperLanguages');
    expect(languageNoteKey('gemini')).toBeNull();
  });
});
