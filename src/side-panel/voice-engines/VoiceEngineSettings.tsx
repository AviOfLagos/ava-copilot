import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { t } from '@extension/i18n';
import {
  KITTEN_VOICES,
  KOKORO_VOICES,
  sttModelId,
  ttsSettingsStore,
  voiceEngineSettingsStore,
  voiceTtsEngine,
} from '@extension/storage';
import type {
  InstalledVoiceModels,
  SttEngineId,
  VoiceEngineSettings as Settings,
  VoiceModelId,
  VoiceTtsEngineId,
} from '@extension/storage';
import { Switch } from '../components/ui/switch';
import type { PanelApi } from '../registry';
import { localChatRequirement, voiceModelRequirement } from '../requirements/catalog';
import { RequirementCard, installSuffix, useRequirementFlow } from '../requirements/RequirementCard';
import { DownloadBar, progressText } from '../voice-models/VoiceModelsCard';
import { languageNoteKey } from './languages';
import {
  bytesFor,
  cancelDownload,
  clearDownloadError,
  megabytes,
  removeDownloaded,
  startDownload,
  useDownloadState,
} from '../voice-models/downloads';

const SELECT_CLASS = 'glass w-full rounded-lg px-2 py-1.5 text-[13px] text-foreground outline-none';
const ROW = 'flex flex-col gap-1.5 px-3 py-2.5';
const HINT = 'text-muted-foreground text-[11.5px]';
const BUTTON =
  'glass inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-foreground transition-colors hover:bg-accent disabled:opacity-50';

interface Status {
  installed: InstalledVoiceModels;
  sizesMb: Record<VoiceModelId, number>;
  economy: { stt: { engine: string; model?: string }; tts: { engine: string; voice: string } } | null;
  economyError: string | null;
}

const MODEL_ROWS: { id: VoiceModelId; label: Parameters<typeof t>[0] }[] = [
  { id: 'moonshine-tiny', label: 'voice_engine_model_moonshineTiny' },
  { id: 'moonshine-base', label: 'voice_engine_model_moonshineBase' },
  { id: 'whisper-base', label: 'voice_engine_model_whisper' },
  { id: 'vosk', label: 'voice_engine_model_vosk' },
  { id: 'kitten', label: 'voice_engine_model_kitten' },
  { id: 'kokoro', label: 'voice_engine_model_kokoro' },
];

const ENGINE_NAMES: Record<string, Parameters<typeof t>[0]> = {
  moonshine: 'voice_engine_name_moonshine',
  whisper: 'voice_engine_name_whisper',
  vosk: 'voice_engine_name_vosk',
  kitten: 'voice_engine_name_kitten',
  kokoro: 'voice_engine_name_kokoro',
  system: 'voice_engine_name_system',
};

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/**
 * Settings › Voice engines: how a conversation runs (Gemini Live, or economy with nothing but text leaving the
 * computer), who hears and who speaks, the local models installed, and a test of each.
 */
export default function VoiceEngineSettings({ api }: { api: PanelApi }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ttsEngine, setTtsEngine] = useState<VoiceTtsEngineId>('system');
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<'speak' | 'listen' | 'unload' | null>(null);
  const [result, setResult] = useState<{ text: string; error?: boolean } | null>(null);
  const download = useDownloadState();
  // Choosing an engine whose model is not here asks to install it first, under the select it came from
  const { flow, state: flowState } = useRequirementFlow();
  const [asking, setAsking] = useState<'stt' | 'moonshine' | 'tts' | 'model' | null>(null);
  const [localChat, setLocalChat] = useState<boolean | null>(null);

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

  // The panel makes a new api object on every render; asking must not follow that
  const apiRef = useRef(api);
  apiRef.current = api;
  const refresh = useCallback(() => {
    apiRef.current
      .request<Status>({ type: 'voice_engine_status' })
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  // Which engines an economy conversation would use depends on the settings: ask again when they change
  useEffect(refresh, [refresh, settings, ttsEngine]);
  // Whether a local text model is there for "On this computer"
  useEffect(() => {
    let alive = true;
    void localChatRequirement()
      .then(requirement => requirement.isReady())
      .then(ready => alive && setLocalChat(ready))
      .catch(() => alive && setLocalChat(false));
    return () => {
      alive = false;
    };
  }, [flowState.phase]);
  // And when a download ends, here or in another window
  useEffect(() => {
    if (download.phase !== 'downloading') refresh();
  }, [refresh, download.phase]);

  if (!settings) return null;
  const update = (changes: Partial<Settings>) => void voiceEngineSettingsStore.updateSettings(changes);
  const installed = status?.installed ?? {};
  const has = (id: VoiceModelId) => Boolean(installed[id]);
  // An option whose model is not here says it installs first, and how much
  const missing = (id: VoiceModelId) => (status && !has(id) ? installSuffix(bytesFor([id])) : '');
  const changed = () => api.request({ type: 'voice_models_changed' });

  /** Saves a choice that needs `ids`: at once when they are here, else after the install card's Install. */
  const choose = (where: NonNullable<typeof asking>, ids: VoiceModelId[], save: () => Promise<void> | void) => {
    if (ids.every(has)) {
      flow.cancel();
      void save();
      return;
    }
    setAsking(where);
    void flow.choose(voiceModelRequirement(ids, api.request), save).then(() => refresh());
  };
  const card = (where: NonNullable<typeof asking>) =>
    asking === where && <RequirementCard flow={flow} state={flowState} />;

  const run = async (kind: 'speak' | 'listen' | 'unload') => {
    setBusy(kind);
    setResult(kind === 'listen' ? { text: t('voice_engine_listen_running') } : null);
    try {
      if (kind === 'speak') {
        const reply = await api.request<{
          ms: number;
          stats?: { loadMs?: number | null; speedFactor?: number | null };
        }>({ type: 'voice_engine_test' }, 180_000);
        const parts = [t('voice_engine_test_done', [seconds(reply.ms)])];
        if (reply.stats?.loadMs) parts.push(t('voice_engine_test_load', [seconds(reply.stats.loadMs)]));
        if (reply.stats?.speedFactor) parts.push(t('voice_engine_test_speed', [String(reply.stats.speedFactor)]));
        setResult({ text: parts.join(' · ') });
      } else if (kind === 'listen') {
        const reply = await api.request<{ text: string; ms: number; loadMs: number }>(
          { type: 'voice_engine_listen_test' },
          180_000,
        );
        setResult({
          text: reply.text
            ? t('voice_engine_listen_done', [reply.text, seconds(reply.ms)])
            : t('voice_engine_listen_nothing'),
        });
      } else {
        await api.request({ type: 'voice_engine_unload' });
        setResult({ text: t('voice_engine_unload_done') });
      }
    } catch (error) {
      setResult({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const modelState = (id: VoiceModelId) => {
    const mine = download.ids.includes(id);
    if (mine && download.phase === 'downloading') return 'downloading';
    if (mine && download.phase === 'failed') return 'failed';
    if (!status) return 'unknown';
    if (has(id)) return installed[id]?.downloaded ? 'downloaded' : 'packed';
    return 'missing';
  };

  // The recogniser actually in use, with its size: Whisper takes over a Moonshine nobody picked, so the setting
  // alone does not say
  const inUse = status?.economy?.stt;
  const inUseName = inUse
    ? t(
        MODEL_ROWS.find(row => row.id === inUse.model)?.label ??
          ENGINE_NAMES[inUse.engine] ??
          'voice_engine_name_moonshine',
      )
    : '';
  const economyLine = status?.economy
    ? t('voice_engine_economy_uses', [
        inUseName,
        t(ENGINE_NAMES[status.economy.tts.engine] ?? 'voice_engine_name_system'),
      ])
    : status?.economyError;

  return (
    <>
      <div className={ROW}>
        <label htmlFor="voice-engine-mode" className="text-[13px]">
          {t('voice_engine_mode_label')}
        </label>
        <select
          id="voice-engine-mode"
          className={SELECT_CLASS}
          value={settings.mode}
          onChange={event => update({ mode: event.target.value as Settings['mode'], modeChosen: true })}>
          <option value="auto">{t('voice_engine_mode_auto')}</option>
          <option value="economy">{t('voice_engine_mode_economy')}</option>
          <option value="live">{t('voice_engine_mode_live')}</option>
        </select>
        <p className={HINT}>
          {t(
            settings.mode === 'economy'
              ? 'voice_engine_mode_economy_hint'
              : settings.mode === 'auto'
                ? 'voice_engine_mode_auto_hint'
                : 'voice_engine_mode_live_hint',
          )}
        </p>
        {settings.mode !== 'live' && economyLine && (
          <p className={HINT} data-testid="voice-engine-economy">
            {economyLine}
          </p>
        )}
      </div>

      <div className={ROW}>
        <label htmlFor="voice-engine-stt" className="text-[13px]">
          {t('voice_engine_stt_label')}
        </label>
        <select
          id="voice-engine-stt"
          className={SELECT_CLASS}
          value={settings.stt}
          onChange={event => {
            const stt = event.target.value as SttEngineId;
            const ids = stt === 'gemini' ? [] : [sttModelId(stt, settings.moonshineSize)];
            // Either Moonshine size counts until a size is chosen
            const moonshineHere = stt === 'moonshine' && (has('moonshine-tiny') || has('moonshine-base'));
            choose('stt', moonshineHere ? [] : ids, () => update({ stt, sttChosen: true }));
          }}>
          <option value="gemini">{t('voice_engine_stt_gemini')}</option>
          <option value="moonshine">
            {t('voice_engine_stt_moonshine')}
            {status && !has('moonshine-tiny') && !has('moonshine-base') ? missing('moonshine-tiny') : ''}
          </option>
          <option value="whisper">
            {t('voice_engine_stt_whisper')}
            {missing('whisper-base')}
          </option>
          <option value="vosk">
            {t('voice_engine_stt_vosk')}
            {missing('vosk')}
          </option>
        </select>
        {settings.stt === 'gemini' && settings.mode !== 'live' && (
          <p className={HINT}>{t('voice_engine_stt_gemini_hint')}</p>
        )}
      </div>
      {languageNoteKey(inUse?.engine ?? settings.stt) && (
        <p className={HINT} data-testid="voice-engine-languages">
          {t(languageNoteKey(inUse?.engine ?? settings.stt)!)}
        </p>
      )}
      {card('stt')}

      {settings.stt === 'moonshine' && (
        <div className={ROW}>
          <label htmlFor="voice-engine-moonshine" className="text-[13px]">
            {t('voice_engine_moonshine_label')}
          </label>
          <select
            id="voice-engine-moonshine"
            className={SELECT_CLASS}
            value={settings.moonshineSize}
            onChange={event => {
              const moonshineSize = event.target.value as Settings['moonshineSize'];
              choose('moonshine', [sttModelId('moonshine', moonshineSize)], () => update({ moonshineSize }));
            }}>
            <option value="tiny">
              {t('voice_engine_moonshine_tiny')}
              {missing('moonshine-tiny')}
            </option>
            <option value="base">
              {t('voice_engine_moonshine_base')}
              {missing('moonshine-base')}
            </option>
          </select>
        </div>
      )}
      {card('moonshine')}

      {settings.stt === 'moonshine' &&
        installed[settings.moonshineSize === 'base' ? 'moonshine-base' : 'moonshine-tiny']?.webgpu && (
          <div className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px]">{t('voice_engine_gpu_label')}</div>
              <div className={`mt-0.5 ${HINT}`}>{t('voice_engine_gpu_hint')}</div>
            </div>
            <Switch
              label={t('voice_engine_gpu_label')}
              checked={settings.sttGpu}
              onChange={value => update({ sttGpu: value })}
            />
          </div>
        )}

      <div className={ROW}>
        <label htmlFor="voice-engine-tts" className="text-[13px]">
          {t('voice_engine_tts_label')}
        </label>
        <select
          id="voice-engine-tts"
          className={SELECT_CLASS}
          value={ttsEngine}
          onChange={event => {
            const engine = event.target.value as VoiceTtsEngineId;
            const ids: VoiceModelId[] = engine === 'kitten' || engine === 'kokoro' ? [engine] : [];
            choose('tts', ids, () => voiceEngineSettingsStore.setTtsEngine(engine));
          }}>
          <option value="system">{t('voice_engine_tts_system')}</option>
          <option value="kitten">
            {t('voice_engine_tts_kitten')}
            {missing('kitten')}
          </option>
          <option value="kokoro">
            {t('voice_engine_tts_kokoro')}
            {missing('kokoro')}
          </option>
          <option value="gemini">{t('voice_engine_tts_gemini')}</option>
        </select>
        {ttsEngine === 'gemini' && <p className={HINT}>{t('voice_engine_tts_gemini_hint')}</p>}
      </div>
      {card('tts')}

      {(ttsEngine === 'kitten' || ttsEngine === 'kokoro') && (
        <div className={ROW}>
          <label htmlFor="voice-engine-voice" className="text-[13px]">
            {t('voice_engine_voice_label')}
          </label>
          <select
            id="voice-engine-voice"
            className={SELECT_CLASS}
            value={ttsEngine === 'kitten' ? settings.kittenVoice : settings.kokoroVoice}
            onChange={event =>
              update(ttsEngine === 'kitten' ? { kittenVoice: event.target.value } : { kokoroVoice: event.target.value })
            }>
            {(ttsEngine === 'kitten' ? KITTEN_VOICES : KOKORO_VOICES).map(voice => (
              <option key={voice} value={voice}>
                {voice}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className={ROW}>
        <label htmlFor="voice-engine-model" className="text-[13px]">
          {t('voice_engine_textModel_label')}
        </label>
        <select
          id="voice-engine-model"
          className={SELECT_CLASS}
          value={settings.economyModel}
          onChange={event => {
            const economyModel = event.target.value as Settings['economyModel'];
            if (economyModel !== 'local') {
              flow.cancel();
              update({ economyModel, economyModelChosen: true });
              return;
            }
            setAsking('model');
            void localChatRequirement().then(requirement =>
              flow.choose(requirement, () => update({ economyModel, economyModelChosen: true })),
            );
          }}>
          <option value="chat">{t('voice_engine_textModel_chat')}</option>
          <option value="fast">{t('voice_engine_textModel_fast')}</option>
          <option value="local">
            {t('voice_engine_textModel_local')}
            {localChat === false ? installSuffix() : ''}
          </option>
        </select>
        {settings.economyModel === 'local' && localChat === false && flowState.phase === 'idle' && (
          <p className="text-destructive text-[11.5px]" data-testid="voice-engine-local-missing">
            {t('requirement_localChat_missing')}
          </p>
        )}
      </div>
      {card('model')}

      <div className={ROW}>
        <label htmlFor="voice-engine-idle" className="text-[13px]">
          {t('voice_engine_idle_label')}
        </label>
        <select
          id="voice-engine-idle"
          className={SELECT_CLASS}
          value={settings.idleEndMinutes}
          onChange={event => update({ idleEndMinutes: Number(event.target.value) })}>
          <option value={0}>{t('voice_engine_idle_never')}</option>
          {[2, 3, 5, 10].map(minutes => (
            <option key={minutes} value={minutes}>
              {t('voice_engine_idle_minutes', [String(minutes)])}
            </option>
          ))}
        </select>
      </div>

      <div className={ROW}>
        <div className="text-[13px]">{t('voice_engine_models_title')}</div>
        <ul className="flex flex-col gap-1.5" aria-label={t('voice_engine_models_title')}>
          {MODEL_ROWS.map(({ id, label }) => {
            const state = modelState(id);
            const name = t(label);
            return (
              <li key={id} className="flex flex-col gap-1 text-[12px]" data-testid={`voice-model-${id}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span
                    data-testid={`voice-model-${id}-state`}
                    className={
                      state === 'failed'
                        ? 'text-destructive'
                        : state === 'downloaded' || state === 'packed'
                          ? 'text-foreground'
                          : 'text-muted-foreground'
                    }>
                    {state === 'unknown'
                      ? '…'
                      : state === 'downloading'
                        ? progressText(download)
                        : state === 'failed'
                          ? t('voice_models_state_failed')
                          : state === 'missing'
                            ? t('voice_engine_models_notInstalled', [String(megabytes(bytesFor([id])))])
                            : state === 'packed'
                              ? t('voice_models_state_packed')
                              : t('voice_engine_models_installed', [String(megabytes(installed[id]?.bytes ?? 0))])}
                  </span>
                  {state === 'downloading' ? (
                    <button
                      type="button"
                      className={BUTTON}
                      onClick={cancelDownload}
                      aria-label={t('voice_models_cancel_named', [name])}>
                      {t('voice_models_cancel')}
                    </button>
                  ) : state === 'missing' || state === 'failed' ? (
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={download.phase === 'downloading'}
                      aria-label={t('voice_models_download_named', [name])}
                      onClick={() => {
                        clearDownloadError();
                        void startDownload([id], changed);
                      }}>
                      {t(state === 'failed' ? 'voice_models_retry' : 'voice_models_download')}
                    </button>
                  ) : state === 'downloaded' ? (
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={download.phase === 'downloading'}
                      aria-label={t('voice_models_remove_named', [name])}
                      onClick={() => void removeDownloaded(id, changed).then(refresh)}>
                      {t('voice_models_remove')}
                    </button>
                  ) : null}
                </div>
                {state === 'downloading' && <DownloadBar download={download} label={name} />}
              </li>
            );
          })}
        </ul>
        <p className={HINT}>{t('voice_engine_models_hint')}</p>
      </div>

      <div className={ROW}>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void run('speak')}>
            {busy === 'speak' && <Loader2 className="size-3.5 animate-spin" />}
            {t('voice_engine_test_button')}
          </button>
          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void run('listen')}>
            {busy === 'listen' && <Loader2 className="size-3.5 animate-spin" />}
            {t('voice_engine_listen_button')}
          </button>
          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void run('unload')}>
            {t('voice_engine_unload_button')}
          </button>
        </div>
        {result && (
          <p
            role="status"
            data-testid="voice-engine-result"
            className={result.error ? 'text-destructive text-[11.5px]' : HINT}>
            {result.text}
          </p>
        )}
      </div>
    </>
  );
}
