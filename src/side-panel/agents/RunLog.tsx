import { useMemo } from 'react';
import {
  AlertTriangle,
  Brain,
  CircleDot,
  Flag,
  Hand,
  ListChecks,
  MousePointerClick,
  Play,
  RefreshCw,
  Send,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { t } from '@extension/i18n';
import { db } from '@extension/storage';
import type { RunRecord, RunStep, ThreadMessage, UsageEvent } from '@extension/storage';
import { cn } from '@extension/ui';
import { buildRunLog, runThreadId } from '@src/background/agents/runlog';
import type { RunLogEntry, RunLogKind } from '@src/background/agents/runlog';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import { durationText, STATUS_LABEL, statusTone } from '../workflows/meta';
import { formatTokens, formatUsd, runLogLabels, runTriggerText } from './meta';

type MessageKey = Parameters<typeof t>[0];

const KIND: Record<RunLogKind, { icon: LucideIcon; label: MessageKey }> = {
  trigger: { icon: Zap, label: 'agents_log_trigger' },
  start: { icon: Play, label: 'agents_log_start' },
  task: { icon: ListChecks, label: 'agents_log_task' },
  plan: { icon: Brain, label: 'agents_log_plan' },
  action: { icon: MousePointerClick, label: 'agents_log_action' },
  notice: { icon: CircleDot, label: 'agents_log_notice' },
  retry: { icon: RefreshCw, label: 'agents_log_retry' },
  error: { icon: AlertTriangle, label: 'agents_log_error' },
  model: { icon: Sparkles, label: 'agents_log_model' },
  approval: { icon: Hand, label: 'agents_log_approval' },
  publish: { icon: Send, label: 'agents_log_publish' },
  end: { icon: Flag, label: 'agents_log_end' },
};

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function entryText(entry: RunLogEntry, run: RunRecord): string {
  switch (entry.kind) {
    case 'trigger':
      return `${runTriggerText(run)}${entry.text ? ` · ${entry.text}` : ''}${run.tainted ? ` · ${t('agents_log_tainted')}` : ''}`;
    case 'start':
      return t('agents_log_startText', [entry.text || '—']);
    case 'model':
      return `${entry.model ?? entry.text} · ${t('agents_tokens', [formatTokens(entry.tokens ?? 0)])}${
        entry.costUsd === null || entry.costUsd === undefined
          ? ` · ${t('agents_unpriced')}`
          : ` · ${formatUsd(entry.costUsd)}`
      }`;
    case 'approval':
      return entry.text === 'inbox' ? t('agents_log_asked') : entry.text;
    case 'publish':
      return entry.status === 'dropped'
        ? t('agents_log_dropped', [entry.text])
        : t('agents_log_posted', [entry.text, entry.status ?? '0']);
    case 'end':
      return `${t(STATUS_LABEL[(entry.status ?? 'succeeded') as RunRecord['status']])}${entry.text ? ` · ${entry.text}` : ''}`;
    default:
      return entry.text;
  }
}

function Entry({ entry, run }: { entry: RunLogEntry; run: RunRecord }) {
  const { icon: Icon, label } = KIND[entry.kind];
  const text = entryText(entry, run);
  const long = entry.kind === 'task' || text.length > 280;
  const tone =
    entry.kind === 'error' || (entry.kind === 'end' && entry.status !== 'succeeded' && entry.status !== 'cancelled')
      ? 'text-destructive'
      : entry.kind === 'approval'
        ? 'text-hold'
        : 'text-muted-foreground';
  return (
    <li data-log-kind={entry.kind} className="flex gap-2 py-1">
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', tone)} aria-hidden />
      <div className="min-w-0 flex-1 text-[12px] leading-relaxed">
        <span className="text-muted-foreground font-mono text-[10.5px]">
          {clock(entry.at)} · {t(label)}
        </span>
        {long ? (
          <details className="group">
            <summary className="cursor-pointer select-none truncate">{text.split('\n')[0]}</summary>
            <p className="bg-secondary mt-1 whitespace-pre-wrap break-words rounded-md px-2 py-1.5 font-mono text-[11px]">
              {text}
            </p>
          </details>
        ) : (
          <p className="whitespace-pre-wrap break-words">{text}</p>
        )}
      </div>
    </li>
  );
}

/** One run's log: what set it off, what its chat did, every model call with its cost, and how it ended. */
export function RunLog({ run, onOpenChat }: { run: RunRecord; onOpenChat: (threadId: string) => void }) {
  const steps = useLive(() => db.runSteps.where('runId').equals(run.id).toArray(), [run.id], [] as RunStep[]);
  const threadId = runThreadId(steps);
  const messages = useLive(
    () =>
      threadId ? db.messages.where('threadId').equals(threadId).sortBy('seq') : Promise.resolve([] as ThreadMessage[]),
    [threadId],
    [] as ThreadMessage[],
  );
  const usage = useLive(
    () =>
      threadId && run.agentId
        ? db.usageEvents
            .where('agentId')
            .equals(run.agentId)
            .filter(event => event.sessionId === threadId && event.at >= run.startedAt)
            .toArray()
        : Promise.resolve([] as UsageEvent[]),
    [threadId, run.agentId, run.startedAt, run.status],
    [] as UsageEvent[],
  );
  const labels = useMemo(runLogLabels, []);
  const { entries, summary } = useMemo(
    () => buildRunLog({ run, steps, messages, usage, labels }),
    [run, steps, messages, usage, labels],
  );

  return (
    <section aria-label={t('agents_log_title')} data-run-log={run.id} className="bg-secondary/40 rounded-xl px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
        <span className={cn('size-2 rounded-full', statusTone(run.status))} aria-hidden />
        <span className="font-medium">{t(STATUS_LABEL[run.status])}</span>
        <span className="text-muted-foreground">
          {[
            durationText(summary.durationMs),
            t('agents_log_calls', [String(summary.modelCalls)]),
            t('agents_tokens', [formatTokens(summary.inputTokens + summary.outputTokens)]),
            formatUsd(summary.costUsd),
            summary.retries ? t('agents_log_retries', [String(summary.retries)]) : null,
            summary.errors ? t('agents_log_errors', [String(summary.errors)]) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className="flex-1" />
        {threadId && (
          <Button size="sm" variant="ghost" onClick={() => onOpenChat(threadId)}>
            {t('agents_log_openChat')}
          </Button>
        )}
      </div>
      {summary.models.length > 0 && (
        <p className="text-muted-foreground mt-0.5 font-mono text-[10.5px]">{summary.models.join(', ')}</p>
      )}
      <ol className="divide-border/40 mt-1.5 flex flex-col divide-y">
        {entries.map((entry, index) => (
          <Entry key={`${entry.kind}-${entry.at}-${index}`} entry={entry} run={run} />
        ))}
      </ol>
    </section>
  );
}
