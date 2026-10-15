import { t } from '@extension/i18n';
import { LIVE_VOICES, VOICE_LANGUAGES } from '@extension/storage';
import { useAssistantName } from '../hooks/useAssistant';
import type { PanelApi } from '../registry';
import { HINT, INPUT } from './AboutYouSettings';
import { useVoiceIdentity } from './useIdentity';

const ROW = 'flex flex-col gap-1.5 px-3 py-2.5';

/**
 * Settings › Voice and language: the Gemini voice and the language of spoken conversations, fixed so they never
 * drift. A personality's own voice applies to read-aloud only when the user gave it one.
 */
export default function VoiceIdentitySettings({ api }: { api: PanelApi }) {
  const name = useAssistantName();
  const settings = useVoiceIdentity();
  const save = (changes: Record<string, string>) =>
    void api.request({ type: 'identity_voice_save', ...settings, ...changes }).catch(() => {});
  return (
    <>
      <div className={ROW}>
        <label htmlFor="ava-live-voice" className="text-[13px]">
          {t('ava_voice_live_label')}
        </label>
        <select
          id="ava-live-voice"
          className={INPUT}
          value={settings.liveVoice}
          onChange={event => save({ liveVoice: event.target.value })}>
          {LIVE_VOICES.map(voice => (
            <option key={voice.name} value={voice.name}>
              {voice.name} · {voice.note}
            </option>
          ))}
        </select>
        <p className={HINT}>{t('ava_voice_live_hint')}</p>
      </div>
      <div className={ROW}>
        <label htmlFor="ava-voice-language" className="text-[13px]">
          {t('ava_voice_language_label')}
        </label>
        <select
          id="ava-voice-language"
          className={INPUT}
          value={settings.language}
          onChange={event => save({ language: event.target.value })}>
          {!VOICE_LANGUAGES.some(language => language.code === settings.language) && (
            <option value={settings.language}>{settings.language}</option>
          )}
          {VOICE_LANGUAGES.map(language => (
            <option key={language.code} value={language.code}>
              {language.name} ({language.code})
            </option>
          ))}
        </select>
        <p className={HINT}>{t('ava_voice_language_hint', [name])}</p>
      </div>
    </>
  );
}
