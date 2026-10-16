import { useMemo, useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { t } from '@extension/i18n';
import { db, localDay } from '@extension/storage';
import type { AgentProfile, JobRecord, RunRecord, UsageEvent } from '@extension/storage';
import type { AgentTemplateId } from '@src/background/agents/templates';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import type { PanelApi } from '../registry';
import { whenText } from '../workflows/meta';
import AgentDetail, { Avatar, StateBadge } from './AgentDetail';
import { formatUsd, isOpenRun, nextScheduled, triggerText } from './meta';
import { TeamList, TeamSetup } from './TeamView';

/**
 * Agents: they work for the user on their own, in a window of their own. The list puts what waits for the
 * user's review first, then each agent with its state, when it wakes next and what it spent today; an agent
 * opens on its page. Two templates start a new one.
 */

type MessageKey = Parameters<typeof t>[0];

// The single templates; the starter team has its own card (TeamSetup)
const SINGLE_TEMPLATES = ['social_watcher', 'research_scout'] as const satisfies readonly AgentTemplateId[];
const TEMPLATES: Record<(typeof SINGLE_TEMPLATES)[number], { avatar: string; name: MessageKey; hint: MessageKey }> = {
  social_watcher: { avatar: '👀', name: 'agents_template_social', hint: 'agents_template_social_hint' },
  research_scout: { avatar: '🔭', name: 'agents_template_research', hint: 'agents_template_research_hint' },
};

function AgentRow({
  agent,
  openRun,
  next,
  spentUsd,
  onOpen,
}: {
  agent: AgentProfile;
  openRun?: RunRecord;
  next: number | null;
  spentUsd: number;
  onOpen: () => void;
}) {
  const when =
    next !== null && agent.enabled
      ? t('agents_next', [whenText(next)])
      : agent.triggers.length
        ? triggerText(agent.triggers[0]!)
        : t('agents_trigger_manual');
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-agent={agent.name}
        className="glass hover:bg-accent flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors">
        <Avatar agent={agent} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{agent.name}</span>
            <StateBadge agent={agent} openRun={openRun} />
            {agent.draft && agent.status !== 'draft' && <Badge variant="outline">{t('agents_state_change')}</Badge>}
          </span>
          <span className="text-muted-foreground mt-0.5 block truncate text-[11.5px]">
            {when} · {t('agents_spentToday', [formatUsd(spentUsd)])}
          </span>
        </span>
        <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
      </button>
    </li>
  );
}

function AgentList({ api, onOpen }: { api: PanelApi; onOpen: (id: string) => void }) {
  const agents = useLive(() => db.agents.toArray(), [], [] as AgentProfile[]);
  const runs = useLive(
    () =>
      db.runs
        .where('status')
        .anyOf('queued', 'running', 'waiting_user')
        .filter(run => run.kind === 'agent')
        .toArray(),
    [],
    [] as RunRecord[],
  );
  const jobs = useLive(() => db.jobs.where('kind').equals('agent-schedule').toArray(), [], [] as JobRecord[]);
  const today = localDay();
  const usage = useLive(() => db.usageEvents.where('day').equals(today).toArray(), [today], [] as UsageEvent[]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spent = useMemo(() => {
    const byAgent = new Map<string, number>();
    for (const event of usage) {
      if (event.agentId) byAgent.set(event.agentId, (byAgent.get(event.agentId) ?? 0) + (event.costUsd ?? 0));
    }
    return byAgent;
  }, [usage]);

  const review = agents
    .filter(agent => agent.draft)
    .sort((a, b) => (b.draft?.createdAt ?? 0) - (a.draft?.createdAt ?? 0));
  // Agents that own an area are in the team list; the rest here
  const others = agents
    .filter(agent => !agent.draft && !agent.owns?.length)
    .sort((a, b) => a.name.localeCompare(b.name));
  const openRunOf = (id: string) => runs.find(run => run.agentId === id && isOpenRun(run));

  const fromTemplate = async (template: AgentTemplateId) => {
    setBusy(true);
    setError(null);
    try {
      const reply = await api.request<{ id: string }>({ type: 'agents_template', template });
      onOpen(reply.id);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const row = (agent: AgentProfile) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      openRun={openRunOf(agent.id)}
      next={nextScheduled(agent, jobs)}
      spentUsd={spent.get(agent.id) ?? 0}
      onOpen={() => onOpen(agent.id)}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      <header className="px-1">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{t('agents_title')}</h1>
        <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{t('agents_intro')}</p>
      </header>

      <Button
        onClick={() => api.startThread(`${t('agents_new_starter')} `)}
        className="w-full justify-center"
        data-new-agent>
        <Plus className="size-4" aria-hidden />
        {t('agents_new')}
      </Button>

      {error && (
        <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-xl border px-3 py-2 text-[12.5px]">
          {error}
        </div>
      )}

      {review.length > 0 && (
        <section aria-labelledby="agents-review" className="flex flex-col gap-1.5">
          <h2 id="agents-review" className="label-mono px-1">
            {t('agents_section_review')}
          </h2>
          <ul className="flex flex-col gap-1.5">{review.map(row)}</ul>
        </section>
      )}

      <TeamList agents={agents} openRunOf={openRunOf} onOpen={onOpen} />

      {others.length > 0 && (
        <section aria-labelledby="agents-yours" className="flex flex-col gap-1.5">
          <h2 id="agents-yours" className="label-mono px-1">
            {t('agents_section_yours')}
          </h2>
          <ul className="flex flex-col gap-1.5">{others.map(row)}</ul>
        </section>
      )}

      {agents.length === 0 && (
        <div className="glass rounded-2xl px-4 py-5">
          <p className="text-[13px] font-medium">{t('agents_empty_title')}</p>
          <p className="text-muted-foreground mt-1.5 text-[12.5px] leading-relaxed">{t('agents_empty_body')}</p>
          <p className="bg-secondary mt-2.5 rounded-lg px-2.5 py-2 font-mono text-[11.5px] leading-relaxed">
            {t('agents_empty_example')}
          </p>
        </div>
      )}

      <TeamSetup api={api} agents={agents} />

      <section aria-labelledby="agents-templates" className="flex flex-col gap-1.5">
        <h2 id="agents-templates" className="label-mono px-1">
          {t('agents_section_templates')}
        </h2>
        {SINGLE_TEMPLATES.map(template => {
          const meta = TEMPLATES[template];
          return (
            <div key={template} className="glass flex items-center gap-3 rounded-xl px-3 py-2.5">
              <span
                aria-hidden
                className="bg-primary/15 flex size-8 shrink-0 items-center justify-center rounded-lg text-[15px]">
                {meta.avatar}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{t(meta.name)}</span>
                <span className="text-muted-foreground block text-[11.5px]">{t(meta.hint)}</span>
              </span>
              <Button
                size="sm"
                variant="glass"
                onClick={() => void fromTemplate(template)}
                disabled={busy}
                aria-label={t('agents_template_use_a11y', [t(meta.name)])}>
                <Plus className="size-3.5" aria-hidden />
                {t('agents_template_use')}
              </Button>
            </div>
          );
        })}
      </section>
    </div>
  );
}

/** The Agents place: the list, or one agent's page. */
export default function AgentsPlace({ api }: { api: PanelApi }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (openId) return <AgentDetail key={openId} id={openId} api={api} onBack={() => setOpenId(null)} />;
  return <AgentList api={api} onOpen={setOpenId} />;
}
