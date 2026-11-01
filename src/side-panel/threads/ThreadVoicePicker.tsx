import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { llmProviderStore, threadStore, VOICE_LANGUAGES } from '@extension/storage';
import type { InstalledVoiceModels, ThreadRecord, ThreadVoice, VoiceModelId } from '@extension/storage';
import { Mic } from 'lucide-react';
import { installedVoiceModels } from '../requirements/catalog';
import type { PanelApi } from '../registry';

type EngineName = Parameters<typeof t>[0];

const HEAR: { id: NonNullable<ThreadVoice['hear']>; label: EngineName; model?: VoiceModelId[] }[] = [
  { id: 'gemini', label: 'voice_engine_name_gemini' },
  { id: 'whisper', label: 'voice_engine_name_whisper', model: ['whisper-base'] },
  { id: 'moonshine', label: 'voice_engine_name_moonshine', model: ['moonshine-tiny', 'moonshine-base'] },
  { id: 'vosk', label: 'voice_engine_name_vosk', model: ['vosk'] },
];

const SPEAK: { id: NonNullable<ThreadVoice['speak']>; label: EngineName; model?: VoiceModelId[] }[] = [
  { id: 'gemini', label: 'voice_engine_name_gemini' },
  { id: 'kokoro', label: 'voice_engine_name_kokoro', model: ['kokoro'] },
  { id: 'kitten', label: 'voice_engine_name_kitten', model: ['kitten'] },
  { id: 'system', label: 'voice_engine_name_system' },
];

/**
 * How this chat hears and speaks, over Settings: who writes the user's words down, who reads answers aloud, and the
 * language. Only what can run here is offered; Settings › Voice engines downloads the rest.
 */
export default function ThreadVoicePicker({ thread, api }: { thread: ThreadRecord; api?: PanelApi }) {
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState<InstalledVoiceModels>({});
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const voice = thread.voice ?? {};
  const own = Boolean(voice.hear || voice.speak || voice.language);

  useEffect(() => {
    if (!open) return;
    void llmProviderStore
      .getAllProviders()
      .then(providers =>
        setHasGeminiKey(Object.entries(providers).some(([id, p]) => (p.type ?? id) === 'gemini' && Boolean(p.apiKey))),
      );
    if (api) void installedVoiceModels(api.request).then(setInstalled, () => setInstalled({}));
    // The panel's api is new on every render; asking each time it opens is enough
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const available = (option: { id: string; model?: VoiceModelId[] }) =>
    option.id === 'gemini' ? hasGeminiKey : !option.model || option.model.some(id => installed[id]);
  const change = (changes: ThreadVoice) => void threadStore.setVoice(thread.id, { ...voice, ...changes });

  const select = 'text-foreground bg-card min-w-0 flex-1 rounded-md border px-1 py-0.5 text-[11px] outline-none';
  const label = 'text-muted-foreground flex min-w-0 flex-1 flex-col gap-0.5 text-[10px]';

  return (
    <>
      <button
        type="button"
        data-testid="thread-voice"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex shrink-0 items-center gap-1 hover:underline ${own ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
        <Mic className="size-3" />
        {t('thread_voice_label')}
      </button>
      {open && (
        <div className="basis-full space-y-1">
          <div className="flex gap-1.5">
            <label className={label}>
              {t('thread_voice_hear')}
              <select
                value={voice.hear ?? ''}
                onChange={event => change({ hear: (event.target.value || null) as ThreadVoice['hear'] })}
                className={select}>
                <option value="">{t('thread_voice_default')}</option>
                {HEAR.filter(option => available(option) || option.id === voice.hear).map(option => (
                  <option key={option.id} value={option.id}>
                    {t(option.label)}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              {t('thread_voice_speak')}
              <select
                value={voice.speak ?? ''}
                onChange={event => change({ speak: (event.target.value || null) as ThreadVoice['speak'] })}
                className={select}>
                <option value="">{t('thread_voice_default')}</option>
                {SPEAK.filter(option => available(option) || option.id === voice.speak).map(option => (
                  <option key={option.id} value={option.id}>
                    {t(option.label)}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              {t('thread_voice_language')}
              <select
                value={voice.language ?? ''}
                onChange={event => change({ language: event.target.value || null })}
                className={select}>
                <option value="">{t('thread_voice_default')}</option>
                {VOICE_LANGUAGES.map(language => (
                  <option key={language.code} value={language.code}>
                    {language.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-muted-foreground text-[10px]">{t('thread_voice_note')}</p>
        </div>
      )}
    </>
  );
}
