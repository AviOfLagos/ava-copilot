import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { llmProviderStore, threadStore } from '@extension/storage';
import type { ThreadRecord } from '@extension/storage';
import { Cpu, ExternalLink, Globe, RotateCcw, Zap } from 'lucide-react';
import { Switch } from '../components/ui/switch';
import UsageBadge from '../components/UsageBadge';
import { Button } from '../components/ui/button';
import WorkspacePicker from '../workspaces/WorkspacePicker';
import type { PanelApi } from '../registry';
import { alwaysAsks } from '@src/background/gate/origins';
import { MAX_AUTO_TRIES } from '@src/background/retry/classify';
import ThreadVoicePicker from './ThreadVoicePicker';

/** When the next try is due: the time, with the day when it is not today (an agent out of money waits a day). */
function retryTime(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

interface ThreadBarProps {
  thread: ThreadRecord;
  onPopOut?: () => void;
  onRebind: () => void;
  onContinue: () => void;
  // Re-runs the thread's last task with a fresh agent; shown for every error kind
  onRetry: () => void;
  // Drops the try that is queued for a task that stopped by itself
  onStopRetry?: () => void;
  // Opens the notes of the meeting this thread was made for
  onOpenMeeting?: () => void;
  onWorkspace: (workspaceId: string | null) => void;
  // The user's click on the Auto mode switch: the only way it is turned on
  onAutoMode?: (on: boolean) => void;
  isDarkMode?: boolean;
  api?: PanelApi;
}

/**
 * What a thread is attached to and runs on: its tabs, its model, and the error that stopped it.
 */
export default function ThreadBar({
  thread,
  onRebind,
  onContinue,
  onRetry,
  onStopRetry,
  onOpenMeeting,
  onPopOut,
  onWorkspace,
  onAutoMode,
  isDarkMode = false,
  api,
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

  // An agent's or a routine's chat always asks: it has no Auto mode
  const canAuto = !alwaysAsks(thread);
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
        {thread.autoMode === true && canAuto && (
          <span className={`${chip} text-primary border-primary/40 shrink-0`} role="status">
            <Zap className="size-3 shrink-0" />
            {t('auto_chip_on')}
          </span>
        )}
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
        <WorkspacePicker
          value={thread.workspaceId ?? null}
          onChange={onWorkspace}
          emptyLabel={t('workspace_noneOption')}
          disabled={!idle}
          className="max-w-[48%] shrink-0"
        />
        <ThreadVoicePicker thread={thread} api={api} />
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
      {canAuto && onAutoMode && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span>{t('auto_toggle_label')}</span>
            <Switch
              label={t('auto_toggle_label')}
              checked={thread.autoMode === true}
              onChange={value => onAutoMode(value)}
            />
          </div>
          <p className="text-muted-foreground text-[10.5px]">
            {t('auto_asks_title')} {t('auto_asks_list')}
          </p>
        </div>
      )}
      {thread.status === 'error' && thread.error && (
        <div
          role="status"
          className="border-destructive/40 bg-destructive/10 flex items-center justify-between gap-2 rounded-xl border px-2.5 py-1.5 text-[12px]">
          <span>
            {thread.error.message}
            {thread.failure?.retryAt && (
              <span className="text-muted-foreground block">
                {t('retry_banner', [
                  retryTime(thread.failure.retryAt),
                  String(thread.autoTries ?? 1),
                  String(MAX_AUTO_TRIES),
                ])}
              </span>
            )}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {thread.failure?.retryAt && onStopRetry && (
              <Button size="sm" variant="outline" onClick={onStopRetry}>
                {t('retry_stopTrying')}
              </Button>
            )}
            {thread.error.kind !== 'failed' && (
              <Button size="sm" variant="destructive" onClick={onContinue}>
                {thread.error.kind === 'tab_closed' ? t('threads_reopenContinue') : t('threads_continue')}
              </Button>
            )}
            <Button size="sm" variant="destructive" onClick={onRetry}>
              <RotateCcw className="size-3.5" />
              {t('retry_action')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
