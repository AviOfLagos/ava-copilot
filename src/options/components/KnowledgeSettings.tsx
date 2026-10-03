import { useEffect, useRef, useState } from 'react';
import { t } from '@extension/i18n';
import { DEFAULT_KB_SETTINGS, kbSettingsStore, kbStore } from '@extension/storage';
import type { KbSettingsConfig } from '@extension/storage';

interface KnowledgeSettingsProps {
  isDarkMode?: boolean;
}

const RETENTION_DAYS = [0, 30, 90, 180, 365];

/** Asks the background, which owns the knowledge base and its search index. */
async function request(message: Record<string, unknown>): Promise<{ ok: boolean; count?: number; error?: string }> {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || t('errors_unknown'));
  return reply;
}

/**
 * Knowledge base settings: what is added on its own, how long it is kept, and export, import and
 * wipe.
 */
export function KnowledgeSettings({ isDarkMode = false }: KnowledgeSettingsProps) {
  const [settings, setSettings] = useState<KbSettingsConfig>(DEFAULT_KB_SETTINGS);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    kbSettingsStore.getSettings().then(setSettings);
  }, []);

  const update = async (changes: Partial<KbSettingsConfig>) => {
    await kbSettingsStore.updateSettings(changes);
    setSettings(await kbSettingsStore.getSettings());
    // Retention and newly allowed sources apply right away
    await request({ type: 'kb_sweep' }).catch(() => {});
  };

  const run = async (work: () => Promise<string>) => {
    setStatus(null);
    try {
      setStatus({ text: await work(), error: false });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : String(error), error: true });
    }
  };

  const exportAll = () =>
    run(async () => {
      const data = await kbStore.exportAll();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `avi-copilot-knowledge-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      return t('options_kb_exported', [String(data.items.length)]);
    });

  const importFile = (file: File) =>
    run(async () => {
      const data = JSON.parse(await file.text());
      const { count = 0 } = await request({ type: 'kb_import', data });
      return t('options_kb_imported', [String(count)]);
    });

  const wipe = () => {
    if (!window.confirm(t('options_kb_wipeConfirm'))) return;
    void run(async () => {
      await request({ type: 'kb_wipe' });
      return t('options_kb_wiped');
    });
  };

  const heading = `text-base font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`;
  const description = `text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`;
  const toggle = `peer h-6 w-11 rounded-full ${isDarkMode ? 'bg-slate-600' : 'bg-gray-200'} after:absolute after:left-[2px] after:top-[2px] after:size-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300`;
  const button = `rounded-md border px-3 py-2 text-sm font-medium ${isDarkMode ? 'border-slate-600 text-gray-200 hover:bg-slate-700' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`;

  const switches = [
    { key: 'indexChats', label: t('options_kb_indexChats'), desc: t('options_kb_indexChats_desc') },
    { key: 'indexMeetings', label: t('options_kb_indexMeetings'), desc: t('options_kb_indexMeetings_desc') },
  ] as const;

  return (
    <div
      className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-white'} p-6 text-left shadow-sm`}>
      <h2 className={`mb-1 text-left text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
        {t('kb_title')}
      </h2>
      <p className={`mb-4 ${description}`}>{t('options_kb_desc')}</p>
      <div className="space-y-4">
        {switches.map(({ key, label, desc }) => (
          <div key={key} className="flex items-center justify-between">
            <div>
              <h3 className={heading}>{label}</h3>
              <p className={description}>{desc}</p>
            </div>
            <div className="relative inline-flex cursor-pointer items-center">
              <input
                id={`kb-${key}`}
                type="checkbox"
                checked={settings[key]}
                onChange={e => void update({ [key]: e.target.checked })}
                className="peer sr-only"
              />
              <label htmlFor={`kb-${key}`} className={toggle}>
                <span className="sr-only">{label}</span>
              </label>
            </div>
          </div>
        ))}

        <div className="flex items-center justify-between">
          <div>
            <h3 className={heading}>{t('options_kb_retention')}</h3>
            <p className={description}>{t('options_kb_retention_desc')}</p>
          </div>
          <label htmlFor="kb-retention" className="sr-only">
            {t('options_kb_retention')}
          </label>
          <select
            id="kb-retention"
            value={settings.retentionDays}
            onChange={e => void update({ retentionDays: Number(e.target.value) })}
            className={`rounded-md border ${isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-700'} px-3 py-2`}>
            {RETENTION_DAYS.map(days => (
              <option key={days} value={days}>
                {days === 0 ? t('options_kb_retention_forever') : t('options_kb_retention_days', [String(days)])}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <button type="button" onClick={() => void exportAll()} className={button}>
            {t('options_kb_export')}
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} className={button}>
            {t('options_kb_import')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label={t('options_kb_import')}
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importFile(file);
            }}
          />
          <button
            type="button"
            onClick={wipe}
            className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700">
            {t('options_kb_wipe')}
          </button>
        </div>
        {status && (
          <p
            role={status.error ? 'alert' : 'status'}
            className={`text-sm ${status.error ? 'text-red-600' : isDarkMode ? 'text-emerald-300' : 'text-emerald-700'}`}>
            {status.text}
          </p>
        )}
      </div>
    </div>
  );
}
