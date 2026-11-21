import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AppWindow, ArrowLeft, BookOpen, Check, Network, Pause, Pencil, Play, Square, Trash2 } from 'lucide-react';
import { t } from '@extension/i18n';
import { db, localDay } from '@extension/storage';
import type { AgentProfile, JobRecord, RunRecord, UsageEvent } from '@extension/storage';
import { cn } from '@extension/ui';
import { diffProfiles, fieldsOf } from '@src/background/agents/profile';
import type { ProfileField } from '@src/background/agents/profile';
import { runThreadId } from '@src/background/agents/runlog';
import type { AgentTabInfo } from '@src/background/agents/window';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import type { PanelApi } from '../registry';
import { durationText, relativeTime, STATUS_LABEL, statusTone, whenText } from '../workflows/meta';
import { useWorkspaces } from '../workspaces/WorkspacePicker';
import AgentEditor from './AgentEditor';
import {
  agentState,
  budgetText,
  fieldValue,
  formatTokens,
  formatUsd,
  isOpenRun,
  KB_AGENT_FILTER_KEY,
  nextScheduled,
  ROLE_LABEL,
  runTriggerText,
  STATE_LABEL,
  triggerText,
} from './meta';
import { AgentMemory } from '../kb/MemoryScope';
import { RunLog } from './RunLog';
import { StandupButton } from './StandupButton';

type MessageKey = Parameters<typeof t>[0];

const FIELD_LABEL: Record<ProfileField, MessageKey> = {
  name: 'agents_field_name',
  avatar: 'agents_field_avatar',
  instructions: 'agents_field_instructions',
  startUrl: 'agents_field_startUrl',
  domains: 'agents_field_domains',
  triggers: 'agents_field_triggers',
  publishes: 'agents_field_publishes',
  subscribes: 'agents_field_subscribes',
  modelRole: 'agents_field_modelRole',
  budget: 'agents_field_budget',
  skills: 'agents_field_skills',
  connectors: 'agents_field_connectors',
  workspaceId: 'agents_field_workspace',
  inboxResults: 'agents_field_inboxResults',
  executor: 'agents_field_executor',
  owns: 'agents_field_owns',
  charter: 'agents_field_charter',
  personalityId: 'agents_field_personality',
  voices: 'agents_field_voices',
};

export function Avatar({ agent, size = 'md' }: { agent: Pick<AgentProfile, 'avatar' | 'name'>; size?: 'md' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'bg-primary/12 border-primary/25 flex shrink-0 items-center justify-center rounded-xl border font-semibold',
        size === 'lg' ? 'size-10 text-[18px]' : 'size-8 text-[14px]',
      )}>
      {agent.avatar || agent.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function StateBadge({ agent, openRun }: { agent: AgentProfile; openRun?: RunRecord }) {
  const state = agentState(agent, openRun);
  const variant = state === 'waiting' ? 'hold' : state === 'running' || state === 'idle' ? 'default' : 'outline';
  return (
    <Badge variant={variant} data-agent-state={state}>
      {t(STATE_LABEL[state])}
    </Badge>
  );
}

function Section({
  id,
  title,
  children,
  action,
}: {
  id: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 px-1">
        <h2 id={id} className="label-mono flex-1">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-[12px]">
      <dt className="text-muted-foreground w-28 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

function RunRow({ run, open, onToggle }: { run: RunRecord; open: boolean; onToggle: () => void }) {
  const took = run.endedAt ? durationText(run.endedAt - run.startedAt) : null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-agent-run={run.id}
      className={cn(
        'hover:bg-accent flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left',
        open && 'bg-accent',
      )}>
      <span className={cn('mt-[6px] size-2 shrink-0 rounded-full', statusTone(run.status))} aria-hidden />
      <span className="min-w-0 flex-1 text-[12px]">
        <span className="font-medium">{t(STATUS_LABEL[run.status])}</span>
        <span className="text-muted-foreground">
          {' · '}
          {relativeTime(run.startedAt)}
          {' · '}
          {runTriggerText(run)}
          {took ? ` · ${took}` : ''}
          {run.costUsd > 0 ? ` · ${formatUsd(run.costUsd)}` : ''}
          {run.tainted ? ` · ${t('agents_log_tainted')}` : ''}
        </span>
        {run.error && run.status !== 'succeeded' && (
          <span className="text-muted-foreground block truncate">{run.error.message}</span>
        )}
      </span>
    </button>
  );
}

export interface AgentDetailProps {
  id: string;
  api: PanelApi;
  onBack: () => void;
}

/** One agent: its draft to review, what it is told, when it wakes, its tabs, its runs and their log, its knowledge and spend. */
export default function AgentDetail({ id, api, onBack }: AgentDetailProps) {
  const agent = useLive(() => db.agents.get(id), [id], null as AgentProfile | undefined | null);
  const runs = useLive(
    () =>
      db.runs
        .where('agentId')
        .equals(id)
        .filter(run => run.kind === 'agent')
        .sortBy('startedAt')
        .then(list => list.reverse()),
    [id],
    [] as RunRecord[],
  );
  const jobs = useLive(() => db.jobs.where('kind').equals('agent-schedule').toArray(), [], [] as JobRecord[]);
  const usage = useLive(() => db.usageEvents.where('agentId').equals(id).toArray(), [id], [] as UsageEvent[]);
  const workspaces = useWorkspaces();
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<AgentTabInfo[]>([]);

  const liveRun = runs.find(isOpenRun);
  const shownRunId = openRunId ?? runs[0]?.id ?? null;
  const shownRun = runs.find(run => run.id === shownRunId) ?? null;
  const waitingThread = useLive(
    async () => {
      if (liveRun?.status !== 'waiting_user') return null;
      return runThreadId(await db.runSteps.where('runId').equals(liveRun.id).toArray());
    },
    [liveRun?.id, liveRun?.status],
    null as string | null,
  );

  const loadTabs = useCallback(async () => {
    try {
      const reply = await api.request<{ tabs: AgentTabInfo[] }>({ type: 'agents_tabs', id }, 10_000);
      setTabs(reply.tabs ?? []);
    } catch {
      setTabs([]);
    }
  }, [api, id]);
  // The agents' window changes on its own; its tab list is looked at again every few seconds
  useEffect(() => {
    void loadTabs();
    const timer = window.setInterval(() => void loadTabs(), 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, liveRun?.status]);

  const spend = useMemo(() => {
    const today = localDay();
    const weekAgo = Date.now() - 7 * 86_400_000;
    const sum = (events: UsageEvent[]) => ({
      costUsd: events.reduce((total, event) => total + (event.costUsd ?? 0), 0),
      tokens: events.reduce((total, event) => total + event.inputTokens + event.outputTokens, 0),
      calls: events.length,
    });
    const byModel = new Map<string, number>();
    for (const event of usage) byModel.set(event.model, (byModel.get(event.model) ?? 0) + 1);
    return {
      today: sum(usage.filter(event => event.day === today)),
      week: sum(usage.filter(event => event.at >= weekAgo)),
      all: sum(usage),
      models: [...byModel].sort((a, b) => b[1] - a[1]).slice(0, 3),
    };
  }, [usage]);

  if (agent === null) return <div className="flex-1" />;
  if (!agent) {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-4">
        <p className="text-[13px]">{t('agents_gone')}</p>
        <Button size="sm" variant="glass" onClick={onBack}>
          {t('agents_back')}
        </Button>
      </div>
    );
  }

  const isNew = agent.status === 'draft';
  const next = nextScheduled(agent, jobs);
  const changes = agent.draft ? diffProfiles(agent.draft.base, agent.draft.profile) : [];
  const workspaceName = (workspaceId: string | null) =>
    workspaceId
      ? (workspaces.find(workspace => workspace.id === workspaceId)?.name ?? workspaceId)
      : t('agents_edit_noWorkspace');

  const act = async (message: Record<string, unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await api.request(message);
      after?.();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const openKnowledge = () => {
    try {
      sessionStorage.setItem(KB_AGENT_FILTER_KEY, agent.id);
    } catch {
      // The Knowledge base opens unfiltered
    }
    api.go('memory');
  };
  const openGraph = () =>
    void chrome.tabs.create({ url: chrome.runtime.getURL(`graph.html?agent=${encodeURIComponent(agent.id)}`) });

  const fields = fieldsOf(agent);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" data-agent-page={agent.name}>
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="icon" aria-label={t('agents_back')} onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <Avatar agent={agent} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{agent.name}</h1>
          <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px]">
            <StateBadge agent={agent} openRun={liveRun} />
            {next !== null && agent.enabled && !isNew && <span>{t('agents_next', [whenText(next)])}</span>}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {!isNew && !liveRun && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void act({ type: 'agents_run', id }, () => setOpenRunId(null))}>
            <Play className="size-3.5" aria-hidden />
            {t('agents_runNow')}
          </Button>
        )}
        {liveRun && (
          <Button
            size="sm"
            variant="glass"
            disabled={busy}
            onClick={() => void act({ type: 'agents_cancel_run', runId: liveRun.id })}>
            <Square className="size-3.5" aria-hidden />
            {t('agents_stop')}
          </Button>
        )}
        {!isNew && (
          <Button
            size="sm"
            variant="glass"
            disabled={busy}
            onClick={() => void act({ type: 'agents_pause', id, paused: agent.enabled })}>
            {agent.enabled ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            {agent.enabled ? t('agents_pause') : t('agents_resume')}
          </Button>
        )}
        <span className="flex-1" />
        {!isNew && !agent.draft && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('agents_edit')}
            title={t('agents_edit')}
            onClick={() => setEditing(value => !value)}>
            <Pencil className="size-3.5" aria-hidden />
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('agents_delete')}
          title={t('agents_delete')}
          onClick={() => setConfirmDelete(true)}>
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>

      {confirmDelete && (
        <div
          role="group"
          aria-label={t('agents_delete')}
          className="border-destructive/40 bg-destructive/10 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2">
          <p className="min-w-0 flex-1 text-[12.5px]">{t('agents_delete_confirm')}</p>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void act({ type: 'agents_delete', id }, onBack)}>
            {t('agents_delete')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
            {t('agents_cancel')}
          </Button>
        </div>
      )}

      <StandupButton agent={agent} />

      {error && (
        <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-xl border px-3 py-2 text-[12.5px]">
          {error}
        </div>
      )}

      {agent.draft && (
        <section
          aria-label={isNew ? t('agents_draft_new') : t('agents_draft_change')}
          data-agent-draft
          className="border-primary/30 bg-primary/5 rounded-xl border px-3 py-2.5">
          <p className="label-mono">{isNew ? t('agents_draft_new') : t('agents_draft_change')}</p>
          {agent.draft.request && <p className="mt-1 text-[12.5px] leading-relaxed">“{agent.draft.request}”</p>}
          <p className="text-muted-foreground mt-1.5 text-[11.5px]">{t('agents_draft_never')}</p>
          <dl className="divide-border/40 mt-2 flex flex-col divide-y">
            {changes.map(change => {
              const before = fieldValue(change.field, agent.draft!.base, workspaceName);
              const after = fieldValue(change.field, agent.draft!.profile, workspaceName);
              return (
                <div key={change.field} className="py-1.5 text-[12px]" data-change={change.field}>
                  <dt className="font-medium">{t(FIELD_LABEL[change.field])}</dt>
                  <dd className="mt-0.5 flex flex-col gap-0.5">
                    {agent.draft!.base && before && (
                      <span className="text-muted-foreground decoration-destructive/60 line-through">{before}</span>
                    )}
                    <span className="whitespace-pre-wrap break-words">{after || t('agents_none')}</span>
                  </dd>
                </div>
              );
            })}
            {changes.length === 0 && (
              <p className="text-muted-foreground py-1.5 text-[12px]">{t('agents_draft_noChange')}</p>
            )}
          </dl>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Button size="sm" disabled={busy} onClick={() => void act({ type: 'agents_confirm', id })}>
              <Check className="size-3.5" aria-hidden />
              {isNew ? t('agents_create') : t('agents_apply')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void act({ type: 'agents_discard', id }, isNew ? onBack : undefined)}>
              {t('agents_discard')}
            </Button>
          </div>
        </section>
      )}

      {agent.pausedReason && !agent.enabled && (
        <div role="status" className="border-destructive/30 bg-destructive/5 rounded-xl border px-3 py-2 text-[12.5px]">
          <p className="font-medium">{t('agents_autoPaused')}</p>
          <p className="text-muted-foreground mt-0.5">{agent.pausedReason}</p>
        </div>
      )}

      {liveRun?.status === 'waiting_user' && waitingThread && (
        <section
          aria-label={t('agents_waiting_title')}
          className="border-hold/50 bg-hold/10 rounded-xl border px-3 py-2.5">
          <p className="text-[13px] font-medium">{t('agents_waiting_title')}</p>
          <p className="text-muted-foreground mt-1 text-[12px]">
            {t('agents_waiting_body')}
            {liveRun.tainted ? ` ${t('agents_waiting_tainted')}` : ''}
          </p>
          <div className="mt-2">
            <Button size="sm" variant="hold" onClick={() => api.openThread(waitingThread)}>
              {t('agents_waiting_open')}
            </Button>
          </div>
        </section>
      )}

      {editing && !isNew ? (
        <AgentEditor agent={agent} api={api} onDone={() => setEditing(false)} />
      ) : (
        !isNew && (
          <Section id="agent-profile" title={t('agents_section_profile')}>
            <dl className="glass rounded-xl px-3 py-1.5">
              {(fields.owns?.length ?? 0) > 0 && (
                <Row label={t('agents_field_owns')}>
                  <span data-agent-owns>{fields.owns!.join(', ')}</span>
                  {fields.charter && <span className="text-muted-foreground block">{fields.charter}</span>}
                </Row>
              )}
              <Row label={t('agents_field_instructions')}>
                <span className="whitespace-pre-wrap">{fields.instructions}</span>
              </Row>
              <Row label={t('agents_field_triggers')}>
                {fields.triggers.length ? (
                  <ul className="flex flex-col gap-0.5">
                    {fields.triggers.map((trigger, index) => (
                      <li key={`${trigger.type}-${index}`}>{triggerText(trigger)}</li>
                    ))}
                  </ul>
                ) : (
                  t('agents_triggers_none')
                )}
              </Row>
              <Row label={t('agents_field_startUrl')}>{fields.startUrl || t('agents_none')}</Row>
              <Row label={t('agents_field_domains')}>{fields.domains.join(', ') || t('agents_anySite')}</Row>
              <Row label={t('agents_field_modelRole')}>{t(ROLE_LABEL[fields.modelRole] ?? 'agents_role_smart')}</Row>
              <Row label={t('agents_field_workspace')}>{workspaceName(fields.workspaceId)}</Row>
              <Row label={t('agents_field_budget')}>{budgetText(fields.budget)}</Row>
              {fields.publishes.length > 0 && (
                <Row label={t('agents_field_publishes')}>{fields.publishes.join(', ')}</Row>
              )}
              {fields.subscribes.length > 0 && (
                <Row label={t('agents_field_subscribes')}>{fields.subscribes.join(', ')}</Row>
              )}
              {fields.skills.length > 0 && (
                <Row label={t('agents_field_skills')}>{fields.skills.map(skill => `/${skill}`).join(' ')}</Row>
              )}
              <Row label={t('agents_field_inboxResults')}>{fields.inboxResults ? t('agents_yes') : t('agents_no')}</Row>
            </dl>
          </Section>
        )
      )}

      {!isNew && (
        <Section id="agent-tabs" title={t('agents_section_tabs')}>
          {tabs.length ? (
            <ul className="flex flex-col gap-1">
              {tabs.map(tab => (
                <li key={tab.id}>
                  <button
                    type="button"
                    onClick={() => void act({ type: 'agents_focus_tab', tabId: tab.id })}
                    aria-label={t('agents_tab_focus', [tab.title || tab.url])}
                    className="glass hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left">
                    <AppWindow className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px]">{tab.title || tab.url}</span>
                      <span className="text-muted-foreground block truncate font-mono text-[10.5px]">{tab.url}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground px-1 text-[12px]">{t('agents_tabs_none')}</p>
          )}
        </Section>
      )}

      {!isNew && (
        <Section id="agent-runs" title={t('agents_section_runs')}>
          {runs.length ? (
            <ul className="flex flex-col">
              {runs.slice(0, 20).map(run => (
                <li key={run.id} className="flex flex-col gap-1">
                  <RunRow run={run} open={shownRunId === run.id} onToggle={() => setOpenRunId(run.id)} />
                  {shownRunId === run.id && shownRun && <RunLog run={shownRun} onOpenChat={api.openThread} />}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground px-1 text-[12px]">{t('agents_runs_none')}</p>
          )}
        </Section>
      )}

      {!isNew && (
        <Section
          id="agent-knowledge"
          title={t('agents_section_knowledge')}
          action={
            <span className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={openKnowledge}>
                <BookOpen className="size-3.5" aria-hidden />
                {t('agents_knowledge_open')}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('agents_knowledge_graph')}
                title={t('agents_knowledge_graph')}
                onClick={openGraph}>
                <Network className="size-3.5" aria-hidden />
              </Button>
            </span>
          }>
          <AgentMemory agentId={agent.id} />
        </Section>
      )}

      {!isNew && (
        <Section id="agent-usage" title={t('agents_section_usage')}>
          <dl className="glass grid grid-cols-3 gap-2 rounded-xl px-3 py-2 text-center">
            {(
              [
                ['agents_usage_today', spend.today],
                ['agents_usage_week', spend.week],
                ['agents_usage_all', spend.all],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground text-[10.5px]">{t(label)}</dt>
                <dd className="text-[14px] font-semibold">{formatUsd(value.costUsd)}</dd>
                <dd className="text-muted-foreground text-[10.5px]">
                  {t('agents_tokens', [formatTokens(value.tokens)])} · {t('agents_log_calls', [String(value.calls)])}
                </dd>
              </div>
            ))}
          </dl>
          {fields.budget.dailyUsd !== null && (
            <p className="text-muted-foreground px-1 text-[11.5px]">
              {t('agents_usage_cap', [formatUsd(spend.today.costUsd), formatUsd(fields.budget.dailyUsd)])}
            </p>
          )}
          {spend.models.length > 0 && (
            <p className="text-muted-foreground px-1 font-mono text-[10.5px]">
              {spend.models.map(([model, calls]) => `${model} ×${calls}`).join(' · ')}
            </p>
          )}
        </Section>
      )}
    </div>
  );
}
