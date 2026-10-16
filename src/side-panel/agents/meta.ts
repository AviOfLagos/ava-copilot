import { t } from '@extension/i18n';
import type { AgentProfile, AgentProfileFields, AgentTrigger, JobRecord, RunRecord } from '@extension/storage';
import type { RunLogLabels } from '@src/background/agents/runlog';
import { scheduleText } from '../workflows/meta';

type MessageKey = Parameters<typeof t>[0];

export type AgentState = 'draft' | 'paused' | 'running' | 'waiting' | 'idle';

const OPEN = new Set(['queued', 'running', 'waiting_user']);

export const isOpenRun = (run: Pick<RunRecord, 'status'>): boolean => OPEN.has(run.status);

/** Where an agent stands: a draft, paused, working, waiting for the user's click, or idle. */
export function agentState(agent: AgentProfile, openRun: RunRecord | undefined): AgentState {
  if (agent.status === 'draft') return 'draft';
  if (openRun?.status === 'waiting_user') return 'waiting';
  if (openRun) return 'running';
  return agent.enabled ? 'idle' : 'paused';
}

export const STATE_LABEL: Record<AgentState, MessageKey> = {
  draft: 'agents_state_draft',
  paused: 'agents_state_paused',
  running: 'agents_state_running',
  waiting: 'agents_state_waiting',
  idle: 'agents_state_idle',
};

/** A trigger in the user's language. */
export function triggerText(trigger: AgentTrigger): string {
  switch (trigger.type) {
    case 'schedule':
      return scheduleText(trigger.cron);
    case 'tab':
      return t('agents_trigger_tab', [trigger.urlPattern]);
    case 'inbox':
      return trigger.source ? t('agents_trigger_inboxFrom', [trigger.source]) : t('agents_trigger_inbox');
    case 'topic':
      return t('agents_trigger_topic', [trigger.topic]);
    case 'meeting_ended':
      return t('agents_trigger_meeting');
    case 'manual':
      return t('agents_trigger_manual');
  }
}

export const TRIGGER_TYPE_LABEL: Record<AgentTrigger['type'], MessageKey> = {
  schedule: 'agents_triggerType_schedule',
  tab: 'agents_triggerType_tab',
  inbox: 'agents_triggerType_inbox',
  topic: 'agents_triggerType_topic',
  meeting_ended: 'agents_triggerType_meeting',
  manual: 'agents_triggerType_manual',
};

/** What started a run, in the user's language. */
export function runTriggerText(run: Pick<RunRecord, 'trigger'>): string {
  const key: Record<string, MessageKey> = {
    manual: 'agents_by_hand',
    schedule: 'agents_by_schedule',
    tab: 'agents_by_tab',
    inbox: 'agents_by_inbox',
    topic: 'agents_by_topic',
    workflow: 'agents_by_workflow',
    chat: 'agents_by_chat',
    voice: 'agents_by_voice',
    meeting: 'agents_by_meeting',
    handoff: 'agents_by_handoff',
  };
  return t(key[run.trigger.type] ?? 'agents_by_hand');
}

/** The next time one of the agent's schedules fires, from its jobs. */
export function nextScheduled(agent: AgentProfile, jobs: readonly JobRecord[]): number | null {
  const times = jobs
    .filter(job => job.key.startsWith(`agent:${agent.id}:`) && job.status === 'scheduled')
    .map(job => job.runAt);
  return times.length ? Math.min(...times) : null;
}

export const formatUsd = (amount: number): string => `$${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`;

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** The start of a message in the user's language, before its first placeholder. */
function prefixOf(key: MessageKey): string {
  const marker = '\u0001';
  return t(key, [marker, marker]).split(marker)[0]?.trim() ?? '';
}

/** How the chat's notes start in the user's language, so the run log tells waits, retries and failures apart. */
export function runLogLabels(): RunLogLabels {
  return {
    waiting: [prefixOf('gate_waiting')],
    retry: [prefixOf('usage_rateLimited'), t('threads_retried')],
    failed: [prefixOf('exec_task_fail')],
  };
}

// Knowledge base: the panel's own hand-off of an agent filter to the Knowledge base place
export const KB_AGENT_FILTER_KEY = 'avi.kb.agentFilter';

export const ROLE_LABEL: Record<string, MessageKey> = {
  smart: 'agents_role_smart',
  fast: 'agents_role_fast',
  vision: 'agents_role_vision',
  local: 'agents_role_local',
};

/** A budget in the user's language: dollars a day, steps a run, runs a day. */
export function budgetText(budget: AgentProfileFields['budget']): string {
  return [
    budget.dailyUsd === null ? t('agents_edit_noCap') : t('agents_budget_daily', [formatUsd(budget.dailyUsd)]),
    t('agents_budget_steps', [String(budget.maxStepsPerRun)]),
    t('agents_budget_runs', [String(budget.runsPerDay)]),
  ].join(' · ');
}

/** One field of a profile in the user's language, for the draft's diff and the profile view. */
export function fieldValue(
  field: keyof AgentProfileFields,
  profile: AgentProfileFields | null,
  workspaceName: (workspaceId: string | null) => string,
): string {
  if (!profile) return '';
  switch (field) {
    case 'triggers':
      return profile.triggers.length ? profile.triggers.map(triggerText).join('; ') : t('agents_triggers_none');
    case 'budget':
      return budgetText(profile.budget);
    case 'inboxResults':
      return (profile.inboxResults ?? true) ? t('agents_yes') : t('agents_no');
    case 'modelRole':
      return t(ROLE_LABEL[profile.modelRole] ?? 'agents_role_smart');
    case 'workspaceId':
      return workspaceName(profile.workspaceId);
    case 'domains':
      return profile.domains.join(', ') || t('agents_anySite');
    case 'skills':
      return profile.skills.map(skill => `/${skill}`).join(' ');
    case 'startUrl':
      return profile.startUrl ?? '';
    default: {
      const value = profile[field];
      return Array.isArray(value) ? value.join(', ') : String(value ?? '');
    }
  }
}
