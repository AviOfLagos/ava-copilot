/**
 * What Settings › Voice engines says about the languages a local recogniser hears (issue #42): Moonshine and Vosk
 * only know English, Whisper base (the multilingual build) also hears others. Gemini is not local, so it says
 * nothing here.
 */
export function languageNoteKey(
  engine: string,
): 'voice_engine_stt_whisperLanguages' | 'voice_engine_stt_englishOnly' | null {
  if (engine === 'gemini') return null;
  return engine === 'whisper' ? 'voice_engine_stt_whisperLanguages' : 'voice_engine_stt_englishOnly';
}
