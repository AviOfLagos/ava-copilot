import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';

/**
 * Ava's voice and language for spoken conversations, fixed so they never drift between sessions. Gemini Live picks a
 * voice (and follows whatever language it hears) when none is set; here both are always sent.
 */

// Gemini's prebuilt voices (the Live API's native-audio models accept any of the TTS voices), with a short note
export const LIVE_VOICES = [
  { name: 'Aoede', note: 'Breezy' },
  { name: 'Kore', note: 'Firm' },
  { name: 'Leda', note: 'Youthful' },
  { name: 'Zephyr', note: 'Bright' },
  { name: 'Callirrhoe', note: 'Easy-going' },
  { name: 'Autonoe', note: 'Bright' },
  { name: 'Despina', note: 'Smooth' },
  { name: 'Erinome', note: 'Clear' },
  { name: 'Laomedeia', note: 'Upbeat' },
  { name: 'Achernar', note: 'Soft' },
  { name: 'Gacrux', note: 'Mature' },
  { name: 'Pulcherrima', note: 'Forward' },
  { name: 'Vindemiatrix', note: 'Gentle' },
  { name: 'Sulafat', note: 'Warm' },
  { name: 'Puck', note: 'Upbeat' },
  { name: 'Charon', note: 'Informative' },
  { name: 'Fenrir', note: 'Excitable' },
  { name: 'Orus', note: 'Firm' },
  { name: 'Enceladus', note: 'Breathy' },
  { name: 'Iapetus', note: 'Clear' },
  { name: 'Umbriel', note: 'Easy-going' },
  { name: 'Algieba', note: 'Smooth' },
  { name: 'Algenib', note: 'Gravelly' },
  { name: 'Rasalgethi', note: 'Informative' },
  { name: 'Alnilam', note: 'Firm' },
  { name: 'Schedar', note: 'Even' },
  { name: 'Achird', note: 'Friendly' },
  { name: 'Zubenelgenubi', note: 'Casual' },
  { name: 'Sadachbia', note: 'Lively' },
  { name: 'Sadaltager', note: 'Knowledgeable' },
] as const;

export const DEFAULT_LIVE_VOICE = 'Aoede';
export const DEFAULT_VOICE_LANGUAGE = 'en-US';

// Languages offered in Settings (BCP-47) with their names in that language
export const VOICE_LANGUAGES = [
  { code: 'en-US', name: 'English (US)' },
  { code: 'en-GB', name: 'English (UK)' },
  { code: 'en-NG', name: 'English (Nigeria)' },
  { code: 'en-IN', name: 'English (India)' },
  { code: 'en-AU', name: 'English (Australia)' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'es-US', name: 'Español (EE. UU.)' },
  { code: 'es-ES', name: 'Español (España)' },
  { code: 'fr-FR', name: 'Français' },
  { code: 'de-DE', name: 'Deutsch' },
  { code: 'it-IT', name: 'Italiano' },
  { code: 'nl-NL', name: 'Nederlands' },
  { code: 'pl-PL', name: 'Polski' },
  { code: 'tr-TR', name: 'Türkçe' },
  { code: 'ru-RU', name: 'Русский' },
  { code: 'ar-XA', name: 'العربية' },
  { code: 'hi-IN', name: 'हिन्दी' },
  { code: 'id-ID', name: 'Bahasa Indonesia' },
  { code: 'vi-VN', name: 'Tiếng Việt' },
  { code: 'th-TH', name: 'ไทย' },
  { code: 'ja-JP', name: '日本語' },
  { code: 'ko-KR', name: '한국어' },
  { code: 'cmn-CN', name: '中文（普通话）' },
] as const;

export interface VoiceIdentitySettings {
  // A Gemini prebuilt voice name
  liveVoice: string;
  // BCP-47, e.g. en-US
  language: string;
}

export const DEFAULT_VOICE_IDENTITY: VoiceIdentitySettings = {
  liveVoice: DEFAULT_LIVE_VOICE,
  language: DEFAULT_VOICE_LANGUAGE,
};

const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

/** A stored voice name, or the default when it is not one of Gemini's. */
export function liveVoiceOf(name: string | undefined | null): string {
  const found = LIVE_VOICES.find(
    voice =>
      voice.name.toLowerCase() ===
      String(name ?? '')
        .trim()
        .toLowerCase(),
  );
  return found?.name ?? DEFAULT_LIVE_VOICE;
}

/**
 * How to hear the user, for every speech model: they speak this language, with the accent and words of where it is
 * spoken. Speech models guess the language from the accent, so without it a strong accent can be taken for another
 * language.
 */
export function listeningHint(tag: string): string {
  const name = voiceLanguageName(tag);
  const region = /^en-NG$/i.test(tag)
    ? ' The user speaks Nigerian English: expect a Nigerian accent, Nigerian names and places, and Pidgin words; understand them as English.'
    : '';
  return `The user speaks ${name}, whatever their accent; never take their accent for another language.${region}`;
}

/** A stored language tag, or en-US when it is not a BCP-47 tag. */
export function voiceLanguageOf(tag: string | undefined | null): string {
  const value = String(tag ?? '').trim();
  return BCP47.test(value) ? value : DEFAULT_VOICE_LANGUAGE;
}

/** The language's name for instructions, e.g. "English (US)"; the tag itself when it is not in the list. */
export function voiceLanguageName(tag: string): string {
  return VOICE_LANGUAGES.find(language => language.code === tag)?.name ?? tag;
}

/**
 * Whether a Live model takes `speechConfig.languageCode`. Google's native-audio models choose the language
 * themselves and do not support setting it, so it is sent only to the half-cascade models known to accept it;
 * every model also gets a firm instruction to keep to the language.
 */
export function acceptsLanguageCode(model: string): boolean {
  const name = model.toLowerCase();
  if (name.includes('native-audio')) return false;
  return /^(models\/)?gemini-(2\.0-flash-live|live-2\.5-flash)/.test(name);
}

/**
 * The Live setup's `speechConfig`: always the voice, and the language where the model takes it. The voice is the
 * personality's Live voice when it has one (so the user hears who is talking), else Ava's from Settings; either
 * way it is fixed for the whole session, and the language is always the Settings one.
 */
export function liveSpeechConfig(
  model: string,
  settings: Partial<VoiceIdentitySettings>,
  personalityVoice?: string | null,
): { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } }; languageCode?: string } {
  const language = voiceLanguageOf(settings.language);
  const own = LIVE_VOICES.find(voice => voice.name.toLowerCase() === (personalityVoice ?? '').trim().toLowerCase());
  return {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: own?.name ?? liveVoiceOf(settings.liveVoice) } },
    ...(acceptsLanguageCode(model) ? { languageCode: language } : {}),
  };
}

const storage = createStorage<VoiceIdentitySettings>('voice-identity', DEFAULT_VOICE_IDENTITY, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const voiceIdentityStore = {
  ...storage,
  async getSettings(): Promise<VoiceIdentitySettings> {
    const stored = { ...DEFAULT_VOICE_IDENTITY, ...((await storage.get()) ?? {}) };
    return { liveVoice: liveVoiceOf(stored.liveVoice), language: voiceLanguageOf(stored.language) };
  },
  async updateSettings(changes: Partial<VoiceIdentitySettings>): Promise<void> {
    const next = { ...(await voiceIdentityStore.getSettings()), ...changes };
    await storage.set({ liveVoice: liveVoiceOf(next.liveVoice), language: voiceLanguageOf(next.language) });
  },
};
