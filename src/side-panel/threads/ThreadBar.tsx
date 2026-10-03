import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { llmProviderStore, threadStore } from '@extension/storage';
import type { ThreadRecord } from '@extension/storage';

interface ThreadBarProps {
  thread: ThreadRecord;
  onRebind: () => void;
  onContinue: () => void;
  isDarkMode?: boolean;
}

/**
 * What a thread is attached to and runs on: its tabs, its model, and the error that stopped it.
 */
export default function ThreadBar({ thread, onRebind, onContinue, isDarkMode = false }: ThreadBarProps) {
  const [tabTitle, setTabTitle] = useState<string | null>(null);
  const [models, setModels] = useState<{ value: string; label: string }[]>([]);
  const idle = thread.status === 'idle' || thread.status === 'error';
  const muted = isDarkMode ? 'text-gray-400' : 'text-gray-500';

  useEffect(() => {
    let cancelled = false;
    const first = thread.boundTabIds[0];
    if (first === undefined) {
      setTabTitle(null);
      return;
    }
    chrome.tabs
      .get(first)
      .then(tab => !cancelled && setTabTitle(tab.title || tab.url || ''))
      .catch(() => !cancelled && setTabTitle(null));
    return () => {
      cancelled = true;
    };
  }, [thread.boundTabIds]);

  useEffect(() => {
    llmProviderStore.getAllProviders().then(providers => {
      setModels(
        Object.entries(providers).flatMap(([id, provider]) =>
          (provider.modelNames ?? []).map(model => ({
            value: `${id}>${model}`,
            label: `${provider.name || id} · ${model}`,
          })),
        ),
      );
    });
  }, []);

  const current = thread.model ? `${thread.model.provider}>${thread.model.modelName}` : '';
  const changeModel = (value: string) => {
    const [provider, modelName] = value.split('>');
    void threadStore.setModel(thread.id, value ? { provider, modelName } : null);
  };

  return (
    <div
      className={`space-y-1 border-b px-3 py-2 text-xs ${isDarkMode ? 'border-sky-900 text-gray-300' : 'border-sky-100 text-gray-700'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate" title={tabTitle ?? undefined}>
          {tabTitle !== null
            ? thread.boundTabIds.length > 1
              ? t('threads_boundMany', [tabTitle, String(thread.boundTabIds.length - 1)])
              : t('threads_bound', [tabTitle])
            : t('threads_notBound')}
        </span>
        {idle && thread.boundTabIds.length > 0 && (
          <button type="button" onClick={onRebind} className="shrink-0 text-sky-600 underline hover:text-sky-700">
            {t('threads_useThisTab')}
          </button>
        )}
      </div>
      <label className="flex items-center gap-2">
        <span className={muted}>{t('threads_model_label')}</span>
        <select
          value={current}
          disabled={!idle}
          onChange={e => changeModel(e.target.value)}
          className={`min-w-0 flex-1 rounded border px-1 py-0.5 ${isDarkMode ? 'border-slate-600 bg-slate-800' : 'border-sky-100 bg-white'}`}>
          <option value="">{t('threads_model_default')}</option>
          {models.map(model => (
            <option key={model.value} value={model.value}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      {thread.status === 'error' && thread.error && (
        <div
          role="status"
          className={`flex items-center justify-between gap-2 rounded px-2 py-1 ${isDarkMode ? 'bg-red-950 text-red-200' : 'bg-red-50 text-red-700'}`}>
          <span>{thread.error.message}</span>
          {thread.error.kind !== 'failed' && (
            <button type="button" onClick={onContinue} className="shrink-0 rounded bg-red-600 px-2 py-0.5 text-white">
              {thread.error.kind === 'tab_closed' ? t('threads_reopenContinue') : t('threads_continue')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
