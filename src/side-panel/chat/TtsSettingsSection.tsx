import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { llmProviderStore, ProviderTypeEnum, ttsSettingsStore } from '@extension/storage';
import type { ReadAloudMode, TtsEngineId, TtsSettingsConfig } from '@extension/storage';

const SELECT_CLASS = 'glass w-full rounded-lg px-2 py-1.5 text-[13px] text-foreground outline-none';
const row = 'flex flex-col gap-1.5 px-3 py-2.5';

/** Settings › Voice output: when answers are read aloud on their own, which engine, voice and rate. */
export default function TtsSettingsSection() {
  const [settings, setSettings] = useState<TtsSettingsConfig | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const [hasGeminiKey, setHasGeminiKey] = useState(true);

  useEffect(() => {
    const load = () => void ttsSettingsStore.getSettings().then(setSettings);
    load();
    return ttsSettingsStore.subscribe(load);
  }, []);

  useEffect(() => {
    chrome.tts.getVoices(found =>
      setVoices(found.map(voice => voice.voiceName).filter((name): name is string => !!name)),
    );
  }, []);

  useEffect(() => {
    void llmProviderStore
      .getAllProviders()
      .then(providers =>
        setHasGeminiKey(
          Object.values(providers).some(provider => provider.type === ProviderTypeEnum.Gemini && !!provider.apiKey),
        ),
      );
  }, []);

  if (!settings) return null;
  const update = (changes: Partial<TtsSettingsConfig>) => void ttsSettingsStore.updateSettings(changes);

  return (
    <>
      <div className={row}>
        <label htmlFor="tts-read-aloud" className="text-[13px]">
          {t('speak_settings_readAloud_label')}
        </label>
        <select
          id="tts-read-aloud"
          className={SELECT_CLASS}
          value={settings.readAloud}
          onChange={event => update({ readAloud: event.target.value as ReadAloudMode })}>
          <option value="off">{t('speak_settings_readAloud_off')}</option>
          <option value="voice">{t('speak_settings_readAloud_voice')}</option>
          <option value="always">{t('speak_settings_readAloud_always')}</option>
        </select>
      </div>
      <div className={row}>
        <label htmlFor="tts-engine" className="text-[13px]">
          {t('speak_settings_engine_label')}
        </label>
        <select
          id="tts-engine"
          className={SELECT_CLASS}
          value={settings.engine}
          onChange={event => update({ engine: event.target.value as TtsEngineId })}>
          <option value="system">{t('speak_settings_engine_system')}</option>
          <option value="kitten">{t('voice_engine_tts_kitten')}</option>
          <option value="kokoro">{t('voice_engine_tts_kokoro')}</option>
          <option value="gemini">{t('speak_settings_engine_gemini')}</option>
        </select>
        {settings.engine === 'gemini' && !hasGeminiKey && (
          <p className="text-muted-foreground text-[11.5px]">{t('speak_settings_gemini_needsKey')}</p>
        )}
      </div>
      {settings.engine === 'system' && (
        <div className={row}>
          <label htmlFor="tts-voice" className="text-[13px]">
            {t('speak_settings_voice_label')}
          </label>
          <select
            id="tts-voice"
            className={SELECT_CLASS}
            value={settings.voice}
            onChange={event => update({ voice: event.target.value })}>
            <option value="">{t('speak_settings_voice_default')}</option>
            {voices.map(voice => (
              <option key={voice} value={voice}>
                {voice}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className={row}>
        <label htmlFor="tts-rate" className="flex items-center justify-between text-[13px]">
          <span>{t('speak_settings_rate_label')}</span>
          <span className="text-muted-foreground font-mono text-[11.5px]">{settings.rate.toFixed(1)}×</span>
        </label>
        <input
          id="tts-rate"
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={settings.rate}
          onChange={event => update({ rate: Number(event.target.value) })}
          className="w-full"
        />
      </div>
    </>
  );
}
