import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { llmProviderStore, threadStore } from '@extension/storage';
import type { ThreadRecord } from '@extension/storage';
import { Cpu, ExternalLink, Globe } from 'lucide-react';
import UsageBadge from '../components/UsageBadge';
import { Button } from '../components/ui/button';

interface ThreadBarProps {
  thread: ThreadRecord;
  onPopOut?: () => void;
  onRebind: () => void;
  onContinue: () => void;
  // Opens the notes of the meeting this thread was made for
  onOpenMeeting?: () => void;
  isDarkMode?: boolean;
}

/**
 * What a thread is attached to and runs on: its tabs, its model, and the error that stopped it.
 */
export default function ThreadBar({
  thread,
  onRebind,
  onContinue,
  onOpenMeeting,
  onPopOut,
  isDarkMode = false,
}: ThreadBarProps) {
  const [tabTitle, setTabTitle] = useState<string | null>(null);
  const [models, setModels] = useState<{ value: string; label: string }[]>([]);
  const idle = thread.status === 'idle' || thread.status === 'error';

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

  const chip = 'flex h-6 min-w-0 items-center gap-1.5 rounded-full border bg-card px-2 text-[11px]';

  return (
    <div className="border-border/60 shrink-0 space-y-1.5 border-b px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className={`${chip} flex-1`} title={tabTitle ?? undefined}>
          <Globe className="text-primary size-3 shrink-0" />
          <span className="truncate">
            {tabTitle !== null
              ? thread.boundTabIds.length > 1
                ? t('threads_boundMany', [tabTitle, String(thread.boundTabIds.length - 1)])
                : t('threads_bound', [tabTitle])
              : t('threads_notBound')}
          </span>
        </span>
        <label className={`${chip} max-w-[38%] shrink-0`}>
          <Cpu className="text-muted-foreground size-3 shrink-0" />
          <span className="sr-only">{t('threads_model_label')}</span>
          <select
            value={current}
            disabled={!idle}
            onChange={e => changeModel(e.target.value)}
            className="text-foreground min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent text-[11px] outline-none disabled:cursor-default">
            <option value="">{t('threads_model_default')}</option>
            {models.map(model => (
              <option key={model.value} value={model.value}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
        <UsageBadge sessionId={thread.id} isDarkMode={isDarkMode} />
        {onPopOut && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onPopOut}
            aria-label={t('threads_popOut')}
            title={t('threads_popOut')}>
            <ExternalLink className="size-3.5" />
          </Button>
        )}
      </div>
      {(onOpenMeeting || (idle && thread.boundTabIds.length > 0)) && (
        <div className="flex items-center gap-3 px-1 text-[11px]">
          {onOpenMeeting && (
            <button type="button" onClick={onOpenMeeting} className="text-primary hover:underline">
              {t('meeting_openNotes')}
            </button>
          )}
          {idle && thread.boundTabIds.length > 0 && (
            <button
              type="button"
              onClick={onRebind}
              className="text-muted-foreground hover:text-foreground hover:underline">
              {t('threads_useThisTab')}
            </button>
          )}
        </div>
      )}
      {thread.status === 'error' && thread.error && (
        <div
          role="status"
          className="border-destructive/40 bg-destructive/10 flex items-center justify-between gap-2 rounded-xl border px-2.5 py-1.5 text-[12px]">
          <span>{thread.error.message}</span>
          {thread.error.kind !== 'failed' && (
            <Button size="sm" variant="destructive" onClick={onContinue}>
              {thread.error.kind === 'tab_closed' ? t('threads_reopenContinue') : t('threads_continue')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
