import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { t } from '@extension/i18n';
import { byDueThenAge, GENERAL_SUMMARY_ID, historyStore, kbStore, taskStore } from '@extension/storage';
import type { KnowledgeItem, Task, WorkspaceSummary } from '@extension/storage';
import { flat, rollup } from '@src/background/history/rollup';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import { useWorkspaces } from '../workspaces/WorkspacePicker';
import { historyRequest } from './reader';
import { TaskCheckbox } from '../tasks/TaskCheckbox';

function useSummaries(): Record<string, WorkspaceSummary> {
  const [summaries, setSummaries] = useState<Record<string, WorkspaceSummary>>({});
  useEffect(() => {
    const load = () => void historyStore.summaries().then(setSummaries);
    load();
    return historyStore.subscribe(load);
  }, []);
  return summaries;
}

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * A summary's text as the user reads it: headings and list lines, as plain text. It came from a model
 * reading imported sessions, so nothing in it is rendered as HTML or links.
 */
function SummaryText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1 text-[12.5px] leading-relaxed">
      {text.split('\n').map((line, index) => {
        const heading = /^#{1,4}\s+(.*)$/.exec(line.trim());
        if (heading)
          return (
            <h4 key={index} className="label-mono mt-2 first:mt-0">
              {heading[1]}
            </h4>
          );
        if (!line.trim()) return null;
        // A box in a model's words is not a task: the tasks are listed from the board, with working boxes
        return (
          <p key={index} className="whitespace-pre-wrap">
            {line.replace(/^\s*[-*•]\s*/, '• ').replace(/^• \[[ xX]?\]\s*/, '• ')}
          </p>
        );
      })}
    </div>
  );
}

/**
 * Where a workspace is at, or with none picked, every workspace's latest activity and next actions.
 * Reachable from Knowledge base › Where we are.
 */
export default function WorkspaceSummaryView({
  workspaceId,
  onPick,
}: {
  workspaceId: string | null;
  // Opens one workspace's summary from the roll-up
  onPick?: (workspaceId: string) => void;
}) {
  const summaries = useSummaries();
  const workspaces = useWorkspaces();
  const items = useLive(() => kbStore.items(), [], [] as KnowledgeItem[]);
  const openTasks = useLive(() => taskStore.list({ status: 'open' }), [], [] as Task[]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      await historyRequest({ type: 'history_summarize', workspaceId: workspaceId ?? undefined, force: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const entries = useMemo(
    () => rollup(workspaces, summaries, items, Date.now(), t('history_general'), openTasks),
    [workspaces, summaries, items, openTasks],
  );

  const refreshButton = (
    <Button size="sm" variant="glass" disabled={busy} onClick={() => void refresh()}>
      <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} />
      {busy ? t('history_summary_refreshing') : t('history_summary_refresh')}
    </Button>
  );

  if (!workspaceId) {
    return (
      <section
        aria-label={t('history_rollup_title')}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="label-mono">{t('history_rollup_title')}</h3>
          {refreshButton}
        </div>
        {error && (
          <p role="alert" className="text-destructive text-[12px]">
            {error}
          </p>
        )}
        {entries.length === 0 && <p className="text-muted-foreground text-[13px]">{t('history_summary_empty')}</p>}
        <ul className="flex flex-col gap-2">
          {entries.map(entry => (
            <li key={entry.workspaceId} className="glass rounded-xl px-3 py-2.5" aria-label={entry.name}>
              <div className="flex items-baseline justify-between gap-2">
                {onPick && entry.workspaceId !== GENERAL_SUMMARY_ID ? (
                  <button
                    type="button"
                    className="truncate text-left text-[13px] font-medium hover:underline"
                    onClick={() => onPick(entry.workspaceId)}>
                    {entry.name}
                  </button>
                ) : (
                  <span className="truncate text-[13px] font-medium">{entry.name}</span>
                )}
                <span className="text-muted-foreground shrink-0 font-mono text-[10.5px]">
                  {t('history_rollup_week', [String(entry.recent)])}
                </span>
              </div>
              {entry.latest && (
                <div className="text-muted-foreground truncate text-[11.5px]">
                  {t('history_rollup_latest', [flat(entry.latest.title, 80), shortDate(entry.latest.date)])}
                </div>
              )}
              {entry.actions.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-0.5 text-[12px]" aria-label={t('history_rollup_actions')}>
                  {entry.actions.map(action => (
                    <li key={action.id}>
                      <TaskCheckbox taskId={action.id} fallback={flat(action.title, 160)} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const summary = summaries[workspaceId] ?? null;
  const name = workspaces.find(workspace => workspace.id === workspaceId)?.name ?? '';
  const ownTasks = openTasks
    .filter(task => task.workspaceId === (workspaceId === GENERAL_SUMMARY_ID ? null : workspaceId))
    .sort(byDueThenAge);
  return (
    <section
      aria-label={t('history_summary_title', [name])}
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="label-mono truncate">{t('history_summary_title', [name])}</h3>
        {refreshButton}
      </div>
      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
      {!summary ? (
        <p className="text-muted-foreground text-[13px]">{t('history_summary_none')}</p>
      ) : (
        <>
          <div className="text-muted-foreground font-mono text-[10.5px]">
            {t('history_summary_meta', [String(summary.itemCount), shortDate(summary.builtAt)])}
          </div>
          <div className="glass rounded-xl px-3 py-2.5">
            <SummaryText text={summary.text} />
          </div>
          {ownTasks.length > 0 && (
            <section aria-label={t('tasks_summary_title')}>
              <h4 className="label-mono mb-1">{t('tasks_summary_title')}</h4>
              <ul className="flex flex-col gap-1 text-[12.5px]">
                {ownTasks.map(task => (
                  <li key={task.id}>
                    <TaskCheckbox taskId={task.id} fallback={task.title} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {summary.sources.length > 0 && (
            <section aria-label={t('kb_sources')}>
              <h4 className="label-mono mb-1">{t('kb_sources')}</h4>
              <ol className="flex flex-col gap-0.5 text-[11.5px]">
                {summary.sources.map(source => (
                  <li key={source.n} className="truncate">
                    <span className="text-primary font-mono">[{source.n}]</span> {flat(source.title, 90)}
                    <span className="text-muted-foreground"> · {shortDate(source.date)}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </section>
  );
}
