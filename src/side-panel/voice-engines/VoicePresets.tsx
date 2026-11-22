import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { t } from '@extension/i18n';
import {
  activePreset,
  llmProviderStore,
  presetChanges,
  presetStatus,
  recommendPreset,
  ttsVerdict,
  VOICE_PRESETS,
  voiceEngineSettingsStore,
  voiceHealthStore,
  voiceTtsEngine,
  ttsSettingsStore,
} from '@extension/storage';
import type {
  InstalledVoiceModels,
  SpeedVerdict,
  VoiceEngineSettings,
  VoiceHealth,
  VoiceModelId,
  VoicePreset,
  VoicePresetId,
} from '@extension/storage';
import type { PanelApi } from '../registry';
import { DownloadBar, progressText } from '../voice-models/VoiceModelsCard';
import { cancelDownload, clearDownloadError, startDownload, useDownloadState } from '../voice-models/downloads';

const ROW = 'flex flex-col gap-1.5 px-3 py-2.5';
const HINT = 'text-muted-foreground text-[11.5px]';
const BUTTON =
  'glass inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-foreground transition-colors hover:bg-accent disabled:opacity-50';

const NAMES: Record<VoicePresetId, Parameters<typeof t>[0]> = {
  instant: 'voice_preset_instant_name',
  light: 'voice_preset_light_name',
  natural: 'voice_preset_natural_name',
  cloud: 'voice_preset_cloud_name',
};
const DESCRIPTIONS: Record<VoicePresetId, Parameters<typeof t>[0]> = {
  instant: 'voice_preset_instant_desc',
  light: 'voice_preset_light_desc',
  natural: 'voice_preset_natural_desc',
  cloud: 'voice_preset_cloud_desc',
};
const FILES: Record<VoiceModelId, Parameters<typeof t>[0]> = {
  'moonshine-tiny': 'voice_engine_model_moonshineTiny',
  'moonshine-base': 'voice_engine_model_moonshineBase',
  'whisper-base': 'voice_engine_model_whisper',
  vosk: 'voice_engine_model_vosk',
  kitten: 'voice_engine_model_kitten',
  kokoro: 'voice_engine_model_kokoro',
};
const VERDICTS: Record<Exclude<SpeedVerdict, 'unknown'>, Parameters<typeof t>[0]> = {
  fast: 'voice_verdict_fast',
  steady: 'voice_verdict_steady',
  borderline: 'voice_verdict_borderline',
  'too-slow': 'voice_verdict_tooSlow',
};
const ENGINE_LABEL: Record<string, Parameters<typeof t>[0]> = {
  kitten: 'voice_engine_name_kitten',
  kokoro: 'voice_engine_name_kokoro',
  moonshine: 'voice_engine_name_moonshine',
  whisper: 'voice_engine_name_whisper',
  vosk: 'voice_engine_name_vosk',
};

interface Status {
  installed: InstalledVoiceModels;
  sizesMb: Record<VoiceModelId, number>;
}

interface CheckReply {
  tts: Record<string, { ok: boolean; speed?: number; error?: string }>;
  stt: { engine: string; ok: boolean; speed?: number; right?: number; error?: string } | null;
}

/** Whether a Gemini key is saved: the cloud preset needs one. */
async function hasGeminiKey(): Promise<boolean> {
  const providers = await llmProviderStore.getAllProviders();
  return Object.entries(providers).some(
    ([id, provider]) => (provider.type ?? id) === 'gemini' && Boolean(provider.apiKey),
  );
}

/**
 * Settings › Voice engines › Voice presets: this computer's speed measured (Check this computer), and presets that
 * set who hears and who speaks in one choice. A preset whose files are not downloaded says which, and offers the
 * download; the recommended one comes from what was measured, never from a guess.
 */
export default function VoicePresets({ api }: { api: PanelApi }) {
  const [settings, setSettings] = useState<VoiceEngineSettings | null>(null);
  const [ttsEngine, setTtsEngine] = useState(voiceTtsEngine('system'));
  const [health, setHealth] = useState<VoiceHealth | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [gemini, setGemini] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [checked, setChecked] = useState<CheckReply | null>(null);
  const download = useDownloadState();

  useEffect(() => {
    const load = () => void voiceEngineSettingsStore.getSettings().then(setSettings);
    load();
    return voiceEngineSettingsStore.subscribe(load);
  }, []);
  useEffect(() => {
    const load = () => void ttsSettingsStore.getSettings().then(tts => setTtsEngine(voiceTtsEngine(tts.engine)));
    load();
    return ttsSettingsStore.subscribe(load);
  }, []);
  useEffect(() => {
    const load = () => void voiceHealthStore.getHealth().then(setHealth);
    load();
    return voiceHealthStore.subscribe(load);
  }, []);
  useEffect(() => {
    void hasGeminiKey().then(setGemini);
  }, []);

  const apiRef = useRef(api);
  apiRef.current = api;
  const refresh = useCallback(() => {
    apiRef.current
      .request<Status>({ type: 'voice_engine_status' })
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (download.phase !== 'downloading') refresh();
  }, [refresh, download.phase]);

  if (!settings || !health) return null;
  const installed = status?.installed ?? {};
  const changed = () => api.request({ type: 'voice_models_changed' });
  const active = activePreset(settings, ttsEngine);
  const recommended = recommendPreset({ installed, hasGeminiKey: gemini, health });

  const check = async () => {
    setChecking(true);
    setChecked(null);
    setMessage({ text: t('voice_check_running') });
    try {
      const reply = await api.request<CheckReply>({ type: 'voice_engine_check' }, 300_000);
      setChecked(reply);
      setMessage(null);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setChecking(false);
      refresh();
    }
  };

  const apply = async (preset: VoicePreset) => {
    const { engine, tts } = presetChanges(preset.id);
    await voiceEngineSettingsStore.updateSettings(engine);
    await voiceEngineSettingsStore.setTtsEngine(tts);
    setMessage({ text: t('voice_preset_applied', [t(NAMES[preset.id])]) });
  };

  const machine = health.machine;
  const speakLines = (['kitten', 'kokoro'] as const)
    .filter(engine => health.tts[engine])
    .map(engine => {
      const speed = health.tts[engine]!.speed;
      const verdict = ttsVerdict(speed);
      return t('voice_check_speed', [
        t(ENGINE_LABEL[engine]),
        speed.toFixed(1),
        verdict === 'unknown' ? '' : t(VERDICTS[verdict]),
      ]);
    });
  const hearing = (['moonshine', 'whisper', 'vosk'] as const).find(engine => health.stt[engine]);
  const heardRight = checked?.stt?.right;

  return (
    <>
      <div className={ROW}>
        <div className="text-[13px]">{t('voice_check_title')}</div>
        <p className={HINT} data-testid="voice-check-machine">
          {machine
            ? t('voice_check_machine', [
                String(machine.cores),
                machine.memoryGb ? t('voice_check_memory', [String(machine.memoryGb)]) : t('voice_check_memoryUnknown'),
                machine.webgpu ? t('voice_check_yes') : t('voice_check_no'),
              ])
            : t('voice_check_never')}
        </p>
        {speakLines.map(line => (
          <p key={line} className={HINT} data-testid="voice-check-speak">
            {line}
          </p>
        ))}
        {hearing && (
          <p className={HINT} data-testid="voice-check-hear">
            {t('voice_check_hearing', [t(ENGINE_LABEL[hearing]), health.stt[hearing]!.speed.toFixed(1)])}
            {heardRight !== undefined ? ` · ${t('voice_check_heard', [String(Math.round(heardRight * 100))])}` : ''}
          </p>
        )}
        {machine && !speakLines.length && !hearing && <p className={HINT}>{t('voice_check_none')}</p>}
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={BUTTON} disabled={checking} onClick={() => void check()}>
            {checking && <Loader2 className="size-3.5 animate-spin" />}
            {t('voice_check_button')}
          </button>
        </div>
        {message && (
          <p role="status" className={message.error ? 'text-destructive text-[11.5px]' : HINT}>
            {message.text}
          </p>
        )}
      </div>

      <div className={ROW}>
        <div className="text-[13px]">{t('voice_preset_title')}</div>
        <p className={HINT}>{t('voice_preset_hint')}</p>
        <ul className="flex flex-col gap-2" aria-label={t('voice_preset_title')}>
          {VOICE_PRESETS.map(preset => {
            const state = presetStatus(preset, { installed, hasGeminiKey: gemini, health });
            const isActive = active === preset.id;
            const isRecommended = recommended.id === preset.id;
            const downloading = preset.models.some(id => download.ids.includes(id)) && download.phase === 'downloading';
            const failed = preset.models.some(id => download.ids.includes(id)) && download.phase === 'failed';
            const speed = preset.localTts ? health.tts[preset.localTts]?.speed : undefined;
            return (
              <li
                key={preset.id}
                data-testid={`voice-preset-${preset.id}`}
                className="glass flex flex-col gap-1.5 rounded-lg px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[13px] font-medium">{t(NAMES[preset.id])}</span>
                  {isActive && (
                    <span className="text-foreground text-[11px]" data-testid={`voice-preset-${preset.id}-active`}>
                      {t('voice_preset_inUse')}
                    </span>
                  )}
                  {isRecommended && (
                    <span
                      className="text-muted-foreground text-[11px]"
                      data-testid={`voice-preset-${preset.id}-recommended`}>
                      {t('voice_preset_recommended')}
                    </span>
                  )}
                </div>
                <p className={HINT}>{t(DESCRIPTIONS[preset.id])}</p>
                {isRecommended && recommended.reason === 'unchecked' && (
                  <p className={HINT}>{t('voice_preset_unchecked')}</p>
                )}
                {speed !== undefined && (
                  <p
                    className={state.tooSlow ? 'text-destructive text-[11.5px]' : HINT}
                    data-testid={`voice-preset-${preset.id}-speed`}>
                    {t(state.tooSlow ? 'voice_preset_tooSlow' : 'voice_preset_keepsUp', [speed.toFixed(1)])}
                  </p>
                )}
                {state.needsKey && <p className={HINT}>{t('voice_preset_needsKey')}</p>}
                {state.missing.length > 0 && (
                  <p className={HINT} data-testid={`voice-preset-${preset.id}-needs`}>
                    {t('voice_preset_needs', [
                      state.missing.map(id => t(FILES[id])).join(', '),
                      String(state.missingMb),
                    ])}
                  </p>
                )}
                {downloading && <DownloadBar download={download} label={t(NAMES[preset.id])} />}
                {downloading && <p className={HINT}>{progressText(download)}</p>}
                <div className="flex flex-wrap gap-1.5">
                  {downloading ? (
                    <button type="button" className={BUTTON} onClick={cancelDownload}>
                      {t('voice_models_cancel')}
                    </button>
                  ) : state.missing.length > 0 ? (
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={download.phase === 'downloading'}
                      onClick={() => {
                        clearDownloadError();
                        void startDownload(state.missing, changed);
                      }}>
                      {t(failed ? 'voice_models_retry' : 'voice_preset_download', [String(state.missingMb)])}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={!state.available || isActive}
                    onClick={() => void apply(preset)}>
                    {t('voice_preset_use')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
