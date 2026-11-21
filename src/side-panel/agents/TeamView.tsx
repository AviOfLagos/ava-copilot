import { useMemo, useState } from 'react';
import { ChevronRight, Users } from 'lucide-react';
import { t } from '@extension/i18n';
import { db } from '@extension/storage';
import type { AgentProfile, RunRecord, RunStep } from '@extension/storage';
import { agentTemplate, GROWTH_TEMPLATE_IDS, TEAM_TEMPLATE_IDS } from '@src/background/agents/templates';
import type { GrowthTemplateId, TeamTemplateId } from '@src/background/agents/templates';
import { ownershipClash, userTimezone } from '@src/background/agents/profile';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import type { PanelApi } from '../registry';
import { useWorkspaces } from '../workspaces/WorkspacePicker';
import { Avatar, StateBadge } from './AgentDetail';

/**
 * The team on the Agents place: the agents that own an area of work (Ava hands them work in it), each with where it
 * stands and what its last run found; and "Set up my team", which makes a draft of each starter the user ticks.
 */

type MessageKey = Parameters<typeof t>[0];

export const TEAM_META: Record<TeamTemplateId, { name: MessageKey; hint: MessageKey }> = {
  team_mail: { name: 'agents_team_mail', hint: 'agents_team_mail_hint' },
  team_social: { name: 'agents_team_social', hint: 'agents_team_social_hint' },
  team_research: { name: 'agents_team_research', hint: 'agents_team_research_hint' },
  team_meetings: { name: 'agents_team_meetings', hint: 'agents_team_meetings_hint' },
  team_calendar: { name: 'agents_team_calendar', hint: 'agents_team_calendar_hint' },
};

// The growth team: agents that work for the product of the workspace picked below
export const GROWTH_META: Record<GrowthTemplateId, { name: MessageKey; hint: MessageKey }> = {
  growth_lead: { name: 'agents_growth_lead', hint: 'agents_growth_lead_hint' },
  growth_marketing: { name: 'agents_growth_marketing', hint: 'agents_growth_marketing_hint' },
};

type SetupTemplateId = TeamTemplateId | GrowthTemplateId;
const META: Record<SetupTemplateId, { name: MessageKey; hint: MessageKey }> = { ...TEAM_META, ...GROWTH_META };

function firstLine(text: string, max = 140): string {
  const line =
    text
      .replace(/[#*_`>]/g, '')
      .split('\n')
      .map(part => part.trim())
      .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The agents that own something, grouped by what they own, with state and last result. */
export function TeamList({
  agents,
  openRunOf,
  onOpen,
}: {
  agents: AgentProfile[];
  openRunOf: (id: string) => RunRecord | undefined;
  onOpen: (id: string) => void;
}) {
  const team = useMemo(
    () =>
      agents
        .filter(agent => agent.status !== 'draft' && agent.owns?.length)
        .sort((a, b) => (a.owns![0] ?? '').localeCompare(b.owns![0] ?? '')),
    [agents],
  );
  const ids = team.map(agent => agent.id);
  // The last run of each that ended well, and its answer
  const lastRuns = useLive(
    async () => {
      if (!ids.length) return [] as { run: RunRecord; step: RunStep | undefined }[];
      const runs = await db.runs.where('agentId').anyOf(ids).toArray();
      const latest = new Map<string, RunRecord>();
      for (const run of runs) {
        if (run.status !== 'succeeded') continue;
        const known = latest.get(run.agentId!);
        if (!known || run.startedAt > known.startedAt) latest.set(run.agentId!, run);
      }
      const picked = [...latest.values()];
      const steps = picked.length
        ? await db.runSteps
            .where('runId')
            .anyOf(picked.map(run => run.id))
            .filter(step => step.nodeId === 'task')
            .toArray()
        : [];
      return picked.map(run => ({ run, step: steps.find(step => step.runId === run.id) }));
    },
    [ids.join(',')],
    [] as { run: RunRecord; step: RunStep | undefined }[],
  );
  if (!team.length) return null;
  return (
    <section aria-labelledby="agents-team" className="flex flex-col gap-1.5" data-agents-team>
      <h2 id="agents-team" className="label-mono px-1">
        {t('agents_team_title')}
      </h2>
      <p className="text-muted-foreground px-1 text-[11.5px] leading-relaxed">{t('agents_team_intro')}</p>
      <ul className="flex flex-col gap-1.5">
        {team.map(agent => {
          const last = lastRuns.find(entry => entry.run.agentId === agent.id);
          const result = last ? firstLine(String(last.step?.output ?? '')) : '';
          return (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => onOpen(agent.id)}
                data-team-agent={agent.name}
                className="glass hover:bg-accent flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors">
                <Avatar agent={agent} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">{agent.name}</span>
                    <StateBadge agent={agent} openRun={openRunOf(agent.id)} />
                  </span>
                  <span
                    className="mt-1 flex flex-wrap gap-1"
                    aria-label={t('agents_team_owns', [agent.owns!.join(', ')])}>
                    {agent.owns!.map(area => (
                      <Badge key={area} variant="secondary">
                        {area}
                      </Badge>
                    ))}
                  </span>
                  <span className="text-muted-foreground mt-1 block break-words text-[11.5px] leading-relaxed">
                    {result ? t('agents_team_last', [result]) : (agent.charter ?? t('agents_team_noResult'))}
                  </span>
                </span>
                <ChevronRight className="text-muted-foreground mt-1 size-4 shrink-0" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Set up my team": tick the starters, pick a workspace, and each becomes a draft to check and create. */
export function TeamSetup({ api, agents }: { api: PanelApi; agents: AgentProfile[] }) {
  const workspaces = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<SetupTemplateId[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const timezone = userTimezone();

  // A starter whose area a switched-on agent the chat could see already owns is shown as taken
  const takenBy = (template: SetupTemplateId) =>
    ownershipClash({ ...agentTemplate(template, timezone), workspaceId: workspaceId || null }, null, agents)?.owner ??
    null;

  const toggle = (template: SetupTemplateId) =>
    setPicked(current =>
      current.includes(template) ? current.filter(item => item !== template) : [...current, template],
    );

  const create = async () => {
    const templates = picked.filter(template => !takenBy(template));
    if (!templates.length) return setMessage({ error: true, text: t('agents_setup_none') });
    setBusy(true);
    setMessage(null);
    try {
      const reply = await api.request<{ ids: string[] }>({
        type: 'agents_team_setup',
        templates,
        workspaceId: workspaceId || null,
      });
      setPicked([]);
      setOpen(false);
      setMessage({ error: false, text: t('agents_setup_done', [String(reply.ids.length)]) });
    } catch (problem) {
      setMessage({ error: true, text: problem instanceof Error ? problem.message : String(problem) });
    } finally {
      setBusy(false);
    }
  };

  const option = (template: SetupTemplateId) => {
    const profile = agentTemplate(template, timezone);
    const owner = takenBy(template);
    const id = `team-${template}`;
    return (
      <label
        key={template}
        htmlFor={id}
        className={`flex items-start gap-2.5 rounded-lg px-2 py-1.5 ${owner ? 'opacity-60' : 'hover:bg-accent cursor-pointer'}`}>
        <input
          id={id}
          type="checkbox"
          data-team-template={template}
          className="mt-1 accent-[var(--color-primary)]"
          checked={picked.includes(template) && !owner}
          disabled={Boolean(owner) || busy}
          onChange={() => toggle(template)}
        />
        <span aria-hidden className="text-[15px] leading-6">
          {profile.avatar}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium">{t(META[template].name)}</span>
          <span className="text-muted-foreground block text-[11.5px] leading-relaxed">
            {owner ? t('agents_setup_owned', [owner.name]) : t(META[template].hint)}
          </span>
        </span>
      </label>
    );
  };

  return (
    <section aria-labelledby="agents-setup" className="flex flex-col gap-1.5">
      <h2 id="agents-setup" className="label-mono px-1">
        {t('agents_setup_title')}
      </h2>
      {message && (
        <p
          role={message.error ? 'alert' : 'status'}
          className={`rounded-xl px-3 py-2 text-[12.5px] ${message.error ? 'border-destructive/40 bg-destructive/10 border' : 'glass'}`}>
          {message.text}
        </p>
      )}
      {!open ? (
        <Button variant="glass" className="w-full justify-center" onClick={() => setOpen(true)} data-team-setup>
          <Users className="size-4" aria-hidden />
          {t('agents_setup_title')}
        </Button>
      ) : (
        <form
          className="glass flex flex-col gap-2 rounded-xl p-3"
          aria-label={t('agents_setup_title')}
          onSubmit={event => {
            event.preventDefault();
            void create();
          }}>
          <p className="text-muted-foreground text-[12px] leading-relaxed">{t('agents_setup_intro')}</p>
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">{t('agents_setup_title')}</legend>
            {TEAM_TEMPLATE_IDS.map(option)}
          </fieldset>
          <fieldset className="flex flex-col gap-1" data-growth-team>
            <legend className="label-mono px-2 pt-1">{t('agents_growth_title')}</legend>
            <p className="text-muted-foreground px-2 text-[11.5px] leading-relaxed">{t('agents_growth_intro')}</p>
            {GROWTH_TEMPLATE_IDS.map(option)}
          </fieldset>
          {workspaces.length > 0 && (
            <label className="flex items-center gap-2 text-[12px]">
              <span className="shrink-0">{t('agents_edit_workspace')}</span>
              <select
                value={workspaceId}
                onChange={event => setWorkspaceId(event.target.value)}
                className="border-input min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1 text-[12.5px]">
                <option value="">{t('agents_edit_noWorkspace')}</option>
                {workspaces.map(workspace => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" disabled={busy || picked.length === 0} data-team-create>
              {t('agents_setup_create')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t('agents_cancel')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
