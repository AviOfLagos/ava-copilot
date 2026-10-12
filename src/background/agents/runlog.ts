import type { AgentTaskState, RunRecord, RunStep, ThreadMessage, UsageEvent } from '@extension/storage';

/**
 * An agent run's log: one timeline from what the run kept (its trigger, task and publish steps), what its
 * chat said (plans, actions, notices, errors, retries) and what its model calls cost. Pure, so the panel
 * builds it from live queries and tests build it from plain records.
 */

export type RunLogKind =
  | 'trigger'
  | 'start'
  | 'task'
  | 'plan'
  | 'action'
  | 'notice'
  | 'retry'
  | 'error'
  | 'model'
  | 'approval'
  | 'publish'
  | 'end';

export interface RunLogEntry {
  at: number;
  kind: RunLogKind;
  text: string;
  model?: string;
  tokens?: number;
  costUsd?: number | null;
  status?: string;
}

export interface RunLogSummary {
  status: RunRecord['status'];
  durationMs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedCalls: number;
  actions: number;
  errors: number;
  retries: number;
  models: string[];
}

/** How the chat's own notes start, in the user's language, to tell retries, waits and failures apart. */
export interface RunLogLabels {
  waiting: string[];
  retry: string[];
  failed: string[];
}

export const ENGLISH_LABELS: RunLogLabels = {
  waiting: ['Waiting for you:'],
  retry: ['Rate limited, retrying', 'Trying the task again'],
  failed: ['Task failed'],
};

const startsWithAny = (text: string, prefixes: readonly string[]) =>
  prefixes.some(prefix => prefix && text.trimStart().startsWith(prefix));

function classify(message: ThreadMessage, labels: RunLogLabels): RunLogKind {
  switch (message.actor) {
    case 'user':
      return 'task';
    case 'planner':
      return 'plan';
    case 'navigator':
      return startsWithAny(message.content, labels.waiting) ? 'approval' : 'action';
    default:
      if (startsWithAny(message.content, labels.failed)) return 'error';
      if (startsWithAny(message.content, labels.retry)) return 'retry';
      return 'notice';
  }
}

export function buildRunLog(input: {
  run: RunRecord;
  steps: readonly RunStep[];
  messages: readonly ThreadMessage[];
  usage: readonly UsageEvent[];
  labels?: RunLogLabels;
  now?: number;
}): { entries: RunLogEntry[]; summary: RunLogSummary } {
  const { run, steps, messages, usage } = input;
  const labels = input.labels ?? ENGLISH_LABELS;
  const entries: RunLogEntry[] = [];

  entries.push({ at: run.startedAt, kind: 'trigger', text: run.trigger.detail, status: run.trigger.type });

  const task = steps.find(step => step.nodeId === 'task');
  const state = task?.state as AgentTaskState | null | undefined;
  if (task?.startedAt) entries.push({ at: task.startedAt, kind: 'start', text: state?.startUrl ?? '' });
  if (state?.askedAt) entries.push({ at: state.askedAt, kind: 'approval', text: 'inbox' });

  for (const message of messages) {
    entries.push({ at: message.ts, kind: classify(message, labels), text: message.content });
  }

  for (const event of usage) {
    entries.push({
      at: event.at,
      kind: 'model',
      text: event.model,
      model: event.model,
      tokens: event.inputTokens + event.outputTokens,
      costUsd: event.costUsd,
    });
  }

  const publish = steps.find(step => step.nodeId === 'publish');
  const posted = (
    publish?.output as { posted?: { topic: string; recipients: number; dropped: string | null }[] } | null
  )?.posted;
  for (const item of posted ?? []) {
    entries.push({
      at: publish?.endedAt ?? publish?.startedAt ?? run.endedAt ?? run.startedAt,
      kind: 'publish',
      text: item.topic,
      status: item.dropped ? 'dropped' : String(item.recipients),
    });
  }

  if (run.endedAt) {
    entries.push({ at: run.endedAt, kind: 'end', text: run.error?.message ?? '', status: run.status });
  }

  // Oldest first; ties keep the order above (trigger, start, chat, calls, publish, end)
  const ordered = entries.map((entry, index) => ({ entry, index }));
  ordered.sort((a, b) => a.entry.at - b.entry.at || a.index - b.index);
  const sorted = ordered.map(item => item.entry);

  const summary: RunLogSummary = {
    status: run.status,
    durationMs: Math.max(0, (run.endedAt ?? input.now ?? Date.now()) - run.startedAt),
    modelCalls: usage.length,
    inputTokens: usage.reduce((sum, event) => sum + event.inputTokens, 0),
    outputTokens: usage.reduce((sum, event) => sum + event.outputTokens, 0),
    costUsd: usage.reduce((sum, event) => sum + (event.costUsd ?? 0), 0),
    unpricedCalls: usage.filter(event => event.costUsd === null).length,
    actions: sorted.filter(entry => entry.kind === 'action').length,
    errors: sorted.filter(entry => entry.kind === 'error').length + (run.error && run.status !== 'cancelled' ? 1 : 0),
    retries: sorted.filter(entry => entry.kind === 'retry').length,
    models: [...new Set(usage.map(event => event.model))],
  };
  return { entries: sorted, summary };
}

/** The thread a run's browser task ran in, if it got that far. */
export function runThreadId(steps: readonly RunStep[]): string | null {
  const state = steps.find(step => step.nodeId === 'task')?.state as AgentTaskState | null | undefined;
  return state?.threadId ?? null;
}
