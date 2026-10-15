import {
  LIVE_VOICES,
  liveVoiceOf,
  meetingSettingsStore,
  ttsSettingsStore,
  VOICE_LANGUAGES,
  voiceIdentityStore,
  voiceLanguageName,
} from '@extension/storage';

/**
 * The settings Ava may change by voice, each only after she reads the change back and the user says yes in their own
 * words. Nothing here touches what she may do (the gate, permissions, budgets, keys) or her name.
 */

interface SpokenSetting {
  describe: string;
  values: readonly string[];
  // The value as stored, from what the model passed (already one of `values`)
  apply: (value: string) => Promise<void>;
  label: (value: string) => string;
}

const onOff = ['on', 'off'] as const;

export const SPOKEN_SETTINGS: Record<string, SpokenSetting> = {
  read_aloud: {
    describe: 'when answers in the side panel are read aloud: off, voice (after the user spoke), always',
    values: ['off', 'voice', 'always'],
    apply: value => ttsSettingsStore.updateSettings({ readAloud: value as 'off' | 'voice' | 'always' }),
    label: value => value,
  },
  voice: {
    describe: `your speaking voice in conversations (from the next conversation): ${LIVE_VOICES.map(v => v.name).join(', ')}`,
    values: LIVE_VOICES.map(voice => voice.name.toLowerCase()),
    apply: value => voiceIdentityStore.updateSettings({ liveVoice: liveVoiceOf(value) }),
    label: value => liveVoiceOf(value),
  },
  language: {
    describe: `the language you speak (from the next conversation), a code: ${VOICE_LANGUAGES.map(l => l.code).join(', ')}`,
    values: VOICE_LANGUAGES.map(language => language.code.toLowerCase()),
    apply: value =>
      voiceIdentityStore.updateSettings({
        language: VOICE_LANGUAGES.find(language => language.code.toLowerCase() === value)?.code ?? value,
      }),
    label: value =>
      voiceLanguageName(VOICE_LANGUAGES.find(language => language.code.toLowerCase() === value)?.code ?? value),
  },
  auto_notes: {
    describe: 'take meeting notes on their own when the user joins a call: on or off',
    values: onOff,
    apply: value => meetingSettingsStore.updateSettings({ autoNotes: value === 'on' }),
    label: value => value,
  },
};

/** Whether the user's words say yes to a question, and do not take it back. */
export function spokenYes(words: string): boolean {
  const text = words.toLowerCase();
  if (/\b(no|nope|don'?t|do not|cancel|stop|never ?mind|wait)\b/.test(text)) return false;
  return /\b(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|confirm(ed)?|please do|correct|that'?s right|sounds good)\b/.test(
    text,
  );
}

/**
 * The change_setting tool: the first call reads the change back; the second, with confirmed, applies it only when the
 * user's latest words say yes.
 */
export async function changeSpokenSetting(
  args: { setting?: unknown; value?: unknown; confirmed?: unknown },
  heard: string,
): Promise<string> {
  const key = String(args.setting ?? '')
    .trim()
    .toLowerCase();
  const setting = SPOKEN_SETTINGS[key];
  if (!setting) {
    return `That setting cannot be changed by voice. These can: ${Object.keys(SPOKEN_SETTINGS).join(', ')}. Anything else is in Settings.`;
  }
  const value = String(args.value ?? '')
    .trim()
    .toLowerCase();
  if (!setting.values.includes(value)) return `"${value}" is not a choice for ${key}: ${setting.describe}.`;
  const change = `${key.replace('_', ' ')} to ${setting.label(value)}`;
  if (args.confirmed !== true) {
    return `Not changed yet. Ask the user: "Change ${change}?" Call change_setting again with confirmed true only after they say yes.`;
  }
  if (!spokenYes(heard)) return `The user has not said yes to changing ${change}. Ask them first.`;
  await setting.apply(value);
  return `Changed ${change}.`;
}

/** The description of the change_setting tool's `setting` argument. */
export function spokenSettingsHelp(): string {
  return Object.entries(SPOKEN_SETTINGS)
    .map(([key, setting]) => `${key} (${setting.describe})`)
    .join('; ');
}
