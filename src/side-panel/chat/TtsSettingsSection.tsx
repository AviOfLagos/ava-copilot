import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { t } from '@extension/i18n';
import {
  KITTEN_VOICES,
  KOKORO_VOICES,
  LIVE_VOICES,
  effectiveTtsEngine,
  llmProviderStore,
  ProviderTypeEnum,
  ttsSettingsStore,
} from '@extension/storage';
import type { InstalledVoiceModels, ReadAloudMode, TtsEngineId, TtsSettingsConfig } from '@extension/storage';
import type { PanelApi } from '../registry';
import { installedVoiceModels, voiceModelRequirement } from '../requirements/catalog';
import { RequirementCard, installSuffix, useRequirementFlow } from '../requirements/RequirementCard';
import { bytesFor } from '../voice-models/downloads';

const SELECT_CLASS = 'glass w-full rounded-lg px-2 py-1.5 text-[13px] text-foreground outline-none';

// Kokoro's voice ids say who speaks: af_heart is an American woman, bm_george a British man
const KOKORO_ACCENT: Record<string, string> = { a: 'US', b: 'UK' };
export function kokoroLabel(id: string): string {
  const [prefix, name = id] = id.split('_');
  const accent = KOKORO_ACCENT[prefix?.[0] ?? ''] ?? '';
  const who = prefix?.[1] === 'f' ? '♀' : prefix?.[1] === 'm' ? '♂' : '';
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  return [title, [accent, who].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}

/** The voices an engine offers, as value and label. System voices come from the browser. */
export function voicesFor(engine: TtsEngineId, systemVoices: string[]): { value: string; label: string }[] {
  if (engine === 'kitten') return KITTEN_VOICES.map(name => ({ value: name, label: name }));
  if (engine === 'kokoro') return KOKORO_VOICES.map(id => ({ value: id, label: kokoroLabel(id) }));
  if (engine === 'gemini')
    return LIVE_VOICES.map(voice => ({ value: voice.name, label: `${voice.name} · ${voice.note}` }));
  return systemVoices.map(name => ({ value: name, label: name }));
}
const row = 'flex flex-col gap-1.5 px-3 py-2.5';

/** Settings › Voice output: when answers are read aloud on their own, which engine, voice and rate. */
export default function TtsSettingsSection({ api }: { api?: PanelApi }) {
  const [settings, setSettings] = useState<TtsSettingsConfig | null>(null);
  // A local voice that is not downloaded yet installs before it is chosen
  const [installed, setInstalled] = useState<InstalledVoiceModels | null>(null);
  const { flow, state } = useRequirementFlow();
  const request = api?.request;
  useEffect(() => {
    if (request && state.phase === 'idle')
      void installedVoiceModels(request).then(setInstalled, () => setInstalled(null));
    // The panel's api is new on every render; asking once per finished choice is enough
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);
  const [voices, setVoices] = useState<string[]>([]);
  const [hasGeminiKey, setHasGeminiKey] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');

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
  // What actually speaks: the user's pick, or until then a voice on this computer when one is installed
  const engine = effectiveTtsEngine(settings, installed);
  const preview = async () => {
    if (!request) return;
    setPreviewError('');
    setPreviewing(true);
    try {
      await request({
        type: 'voice_preview',
        engine: engine === 'gemini' ? 'live' : engine,
        voice: settings.voice,
        rate: settings.rate,
      });
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewing(false);
    }
  };
  const update = (changes: Partial<TtsSettingsConfig>) => void ttsSettingsStore.updateSettings(changes);
  const needs = (engine: 'kitten' | 'kokoro') =>
    installed && !installed[engine] ? installSuffix(bytesFor([engine])) : '';
  const chooseEngine = (engine: TtsEngineId) => {
    // Voice names belong to one engine: a new engine starts on its own default
    const save = () => ttsSettingsStore.updateSettings({ engine, engineChosen: true, voice: '' });
    if ((engine === 'kitten' || engine === 'kokoro') && request && installed && !installed[engine]) {
      void flow.choose(voiceModelRequirement([engine], request), save);
      return;
    }
    flow.cancel();
    void save();
  };

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
          value={engine}
          onChange={event => chooseEngine(event.target.value as TtsEngineId)}>
          <option value="system">{t('speak_settings_engine_system')}</option>
          <option value="kitten">
            {t('voice_engine_tts_kitten')}
            {needs('kitten')}
          </option>
          <option value="kokoro">
            {t('voice_engine_tts_kokoro')}
            {needs('kokoro')}
          </option>
          <option value="gemini">{t('speak_settings_engine_gemini')}</option>
        </select>
        {engine === 'gemini' && !hasGeminiKey && (
          <p className="text-muted-foreground text-[11.5px]">{t('speak_settings_gemini_needsKey')}</p>
        )}
      </div>
      <RequirementCard flow={flow} state={state} />
      <div className={row}>
        <label htmlFor="tts-voice" className="text-[13px]">
          {t('speak_settings_voice_label')}
        </label>
        <div className="flex items-center gap-2">
          <select
            id="tts-voice"
            className={SELECT_CLASS}
            value={settings.voice}
            onChange={event => update({ voice: event.target.value })}>
            <option value="">{t('speak_settings_voice_default')}</option>
            {voicesFor(engine, voices).map(voice => (
              <option key={voice.value} value={voice.value}>
                {voice.label}
              </option>
            ))}
          </select>
          {request && (
            <button
              type="button"
              className="glass flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] disabled:opacity-50"
              disabled={previewing}
              onClick={() => void preview()}>
              <Play className="size-3.5" aria-hidden="true" />
              {t('speak_settings_preview')}
            </button>
          )}
        </div>
        {previewError && <p className="text-muted-foreground text-[11.5px]">{previewError}</p>}
      </div>
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
