import { ArrowUpRight, Bot } from 'lucide-react';
import { t } from '@extension/i18n';
import { db } from '@extension/storage';
import type { AgentRunSpec, AgentTaskState, RunRecord, RunStep } from '@extension/storage';
import { handoffState } from '@src/background/agents/handoff-state';
import type { HandoffState } from '@src/background/agents/handoff-state';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Shimmer } from '../components/ai/shimmer';
import { useLive } from '../hooks/useLive';
import type { PanelApi, TurnAddonProps } from '../registry';

/**
 * The card a chat shows under the turn that handed work to an agent: "Handed to Mail — running / waits for you /
 * done: <answer>", read live from the run record the background keeps. Amber only while it waits for the user's
 * click; its link opens the agent's own chat, where that click is.
 */

type MessageKey = Parameters<typeof t>[0];

const STATE_LABEL: Record<HandoffState, MessageKey> = {
  queued: 'agents_handoff_queued',
  running: 'agents_handoff_running',
  waiting: 'agents_handoff_waiting',
  done: 'agents_handoff_done',
  failed: 'agents_handoff_failed',
  stopped: 'agents_handoff_stopped',
};

const handoffOf = (run: RunRecord) => (run.spec as AgentRunSpec | undefined)?.handoff ?? null;

function firstLine(text: string, max = 160): string {
  const line =
    text
      .replace(/[#*_`>]/g, '')
      .trim()
      .split('\n')
      .find(part => part.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function Card({ run, step, api }: { run: RunRecord; step: RunStep | undefined; api?: PanelApi }) {
  const state = handoffState(run);
  const spec = run.spec as AgentRunSpec;
  const name = spec.agentName;
  const answer = state === 'done' ? firstLine(String(step?.output ?? '')) : '';
  const problem = state === 'failed' ? (run.error?.message ?? '') : '';
  const agentThread = (step?.state as AgentTaskState | null | undefined)?.threadId ?? null;
  const live = state === 'running' || state === 'queued';
  const label = t(STATE_LABEL[state]);
  return (
    <div
      role="status"
      aria-label={t('agents_handoff_a11y', [name, label])}
      data-handoff={state}
      data-handoff-agent={name}
      className={`glass flex items-start gap-2.5 rounded-xl px-3 py-2.5 ${state === 'waiting' ? 'border-hold/45 border' : ''}`}>
      <span
        aria-hidden
        className="bg-primary/12 border-primary/25 flex size-7 shrink-0 items-center justify-center rounded-lg border">
        <Bot className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[12.5px] font-medium">{t('agents_handoff_title', [name])}</span>
          <Badge variant={state === 'waiting' ? 'hold' : state === 'done' ? 'default' : 'outline'}>
            {live ? <Shimmer as="span">{label}</Shimmer> : label}
          </Badge>
        </span>
        {spec.handoff?.area && (
          <span className="text-muted-foreground mt-0.5 block text-[11.5px]">
            {t('agents_handoff_area', [spec.handoff.area])}
          </span>
        )}
        {(answer || problem) && (
          <span
            className="text-muted-foreground mt-1 block break-words text-[12px] leading-relaxed"
            data-handoff-answer>
            {answer || problem}
          </span>
        )}
      </span>
      {api && (agentThread || state === 'queued') && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={state === 'waiting' ? t('agents_handoff_answer', [name]) : t('agents_handoff_open', [name])}
          title={state === 'waiting' ? t('agents_handoff_answer', [name]) : t('agents_handoff_open', [name])}
          onClick={() => (agentThread ? api.openThread(agentThread) : api.go('agents'))}>
          <ArrowUpRight className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  );
}

/** The hand-off cards of one turn of a chat: the runs handed over from it for that request. */
export default function HandoffCards({ thread, requestSeq, api }: TurnAddonProps) {
  const runs = useLive(
    () =>
      db.runs
        .where('kind')
        .equals('agent')
        .filter(run => run.trigger.type === 'handoff' && run.trigger.detail === thread.id)
        .toArray(),
    [thread.id],
    [] as RunRecord[],
  );
  const mine = runs
    .filter(run => (handoffOf(run)?.requestSeq ?? null) === requestSeq)
    .sort((a, b) => a.startedAt - b.startedAt);
  const ids = mine.map(run => run.id);
  const steps = useLive(
    () =>
      ids.length
        ? db.runSteps
            .where('runId')
            .anyOf(ids)
            .filter(step => step.nodeId === 'task')
            .toArray()
        : Promise.resolve([] as RunStep[]),
    [ids.join(',')],
    [] as RunStep[],
  );
  if (!mine.length) return null;
  return (
    <div className="flex flex-col gap-1.5 pl-1">
      {mine.map(run => (
        <Card key={run.id} run={run} step={steps.find(step => step.runId === run.id)} api={api} />
      ))}
    </div>
  );
}
