import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { t } from '@extension/i18n';
import type { AgentProfile, AgentTrigger } from '@extension/storage';
import { AGENT_ROLES, userTimezone } from '@src/background/agents/profile';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import type { PanelApi } from '../registry';
import { useWorkspaces } from '../workspaces/WorkspacePicker';
import { ROLE_LABEL, TRIGGER_TYPE_LABEL, triggerText } from './meta';

const INPUT =
  'border-input w-full min-w-0 rounded-lg border bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)]';

function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11.5px] font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-muted-foreground text-[11px]">{hint}</p>}
    </div>
  );
}

const list = (text: string) =>
  text
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean);

const TRIGGER_TYPES: AgentTrigger['type'][] = ['schedule', 'tab', 'inbox', 'topic', 'meeting_ended', 'manual'];

function makeTrigger(type: AgentTrigger['type'], value: string): AgentTrigger | null {
  const text = value.trim();
  switch (type) {
    case 'schedule':
      return text ? { type, cron: text, timezone: userTimezone() } : null;
    case 'tab':
      return text ? { type, urlPattern: text } : null;
    case 'inbox':
      return text ? { type, source: text } : { type };
    case 'topic':
      return text ? { type, topic: text.toLowerCase() } : null;
    case 'meeting_ended':
    case 'manual':
      return { type };
  }
}

const PLACEHOLDER: Record<AgentTrigger['type'], Parameters<typeof t>[0] | null> = {
  schedule: 'agents_edit_cronHint',
  tab: 'agents_edit_patternHint',
  inbox: 'agents_edit_sourceHint',
  topic: 'agents_edit_topicHint',
  meeting_ended: null,
  manual: null,
};

/** Changes an agent by hand: every field the user decides, checked again in the background before it is kept. */
export default function AgentEditor({
  agent,
  api,
  onDone,
}: {
  agent: AgentProfile;
  api: PanelApi;
  onDone: () => void;
}) {
  const workspaces = useWorkspaces();
  const [name, setName] = useState(agent.name);
  const [avatar, setAvatar] = useState(agent.avatar);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [startUrl, setStartUrl] = useState(agent.startUrl ?? '');
  const [domains, setDomains] = useState(agent.domains.join('\n'));
  const [modelRole, setModelRole] = useState(agent.modelRole);
  const [workspaceId, setWorkspaceId] = useState(agent.workspaceId ?? '');
  const [dailyUsd, setDailyUsd] = useState(agent.budget.dailyUsd === null ? '' : String(agent.budget.dailyUsd));
  const [maxSteps, setMaxSteps] = useState(String(agent.budget.maxStepsPerRun));
  const [runsPerDay, setRunsPerDay] = useState(String(agent.budget.runsPerDay));
  const [publishes, setPublishes] = useState(agent.publishes.join(', '));
  const [inboxResults, setInboxResults] = useState(agent.inboxResults ?? true);
  const [owns, setOwns] = useState((agent.owns ?? []).join(', '));
  const [charter, setCharter] = useState(agent.charter ?? '');
  const [triggers, setTriggers] = useState<AgentTrigger[]>(agent.triggers);
  const [newType, setNewType] = useState<AgentTrigger['type']>('schedule');
  const [newValue, setNewValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addTrigger = () => {
    const trigger = makeTrigger(newType, newValue);
    if (!trigger) return setError(t('agents_edit_triggerNeedsValue'));
    setTriggers(current => [...current, trigger]);
    setNewValue('');
    setError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const daily = dailyUsd.trim() === '' ? null : Number(dailyUsd);
    try {
      await api.request({
        type: 'agents_update',
        id: agent.id,
        fields: {
          name: name.trim(),
          avatar: avatar.trim(),
          instructions: instructions.trim(),
          startUrl: startUrl.trim() || null,
          domains: list(domains),
          modelRole,
          workspaceId: workspaceId || null,
          triggers,
          // Topics it listens to are its topic triggers
          subscribes: triggers.flatMap(trigger => (trigger.type === 'topic' ? [trigger.topic] : [])),
          publishes: list(publishes).map(topic => topic.toLowerCase()),
          inboxResults,
          owns: list(owns),
          charter: charter.trim() || null,
          budget: {
            dailyUsd: daily !== null && Number.isFinite(daily) && daily > 0 ? daily : null,
            maxStepsPerRun: Math.round(Number(maxSteps)) || 1,
            runsPerDay: Math.round(Number(runsPerDay)) || 1,
          },
        },
      });
      onDone();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const id = (field: string) => `agent-edit-${field}`;

  return (
    <form onSubmit={save} aria-label={t('agents_edit_title')} className="glass flex flex-col gap-3 rounded-xl p-3">
      <p className="label-mono">{t('agents_edit_title')}</p>
      <div className="flex gap-2">
        <div className="w-16">
          <Field label={t('agents_edit_avatar')} id={id('avatar')}>
            <input
              id={id('avatar')}
              value={avatar}
              maxLength={8}
              onChange={e => setAvatar(e.target.value)}
              className={INPUT}
            />
          </Field>
        </div>
        <div className="min-w-0 flex-1">
          <Field label={t('agents_edit_name')} id={id('name')}>
            <input
              id={id('name')}
              value={name}
              maxLength={60}
              onChange={e => setName(e.target.value)}
              className={INPUT}
            />
          </Field>
        </div>
      </div>
      <Field label={t('agents_edit_instructions')} id={id('instructions')}>
        <textarea
          id={id('instructions')}
          value={instructions}
          maxLength={4000}
          rows={5}
          onChange={e => setInstructions(e.target.value)}
          className={`${INPUT} resize-y`}
        />
      </Field>
      <Field label={t('agents_edit_owns')} hint={t('agents_edit_ownsHint')} id={id('owns')}>
        <input id={id('owns')} value={owns} onChange={e => setOwns(e.target.value)} className={INPUT} />
      </Field>
      <Field label={t('agents_edit_charter')} id={id('charter')}>
        <input
          id={id('charter')}
          value={charter}
          maxLength={200}
          onChange={e => setCharter(e.target.value)}
          className={INPUT}
        />
      </Field>
      <Field label={t('agents_edit_startUrl')} hint={t('agents_edit_startUrlHint')} id={id('start')}>
        <input
          id={id('start')}
          value={startUrl}
          inputMode="url"
          onChange={e => setStartUrl(e.target.value)}
          className={INPUT}
        />
      </Field>
      <Field label={t('agents_edit_domains')} hint={t('agents_edit_domainsHint')} id={id('domains')}>
        <textarea
          id={id('domains')}
          value={domains}
          rows={2}
          onChange={e => setDomains(e.target.value)}
          className={INPUT}
        />
      </Field>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[11.5px] font-medium">{t('agents_triggers')}</legend>
        {triggers.length === 0 && <p className="text-muted-foreground text-[11.5px]">{t('agents_triggers_none')}</p>}
        <ul className="flex flex-col gap-1">
          {triggers.map((trigger, index) => (
            <li
              key={`${trigger.type}-${index}`}
              className="bg-secondary/60 flex items-center gap-2 rounded-lg px-2 py-1">
              <span className="min-w-0 flex-1 truncate text-[12px]">{triggerText(trigger)}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('agents_edit_removeTrigger', [triggerText(trigger)])}
                onClick={() => setTriggers(current => current.filter((_, at) => at !== index))}>
                <X className="size-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex gap-1.5">
          <select
            aria-label={t('agents_edit_triggerType')}
            value={newType}
            onChange={e => setNewType(e.target.value as AgentTrigger['type'])}
            className={`${INPUT} w-auto`}>
            {TRIGGER_TYPES.map(type => (
              <option key={type} value={type}>
                {t(TRIGGER_TYPE_LABEL[type])}
              </option>
            ))}
          </select>
          {PLACEHOLDER[newType] && (
            <input
              aria-label={t('agents_edit_triggerValue')}
              value={newValue}
              placeholder={t(PLACEHOLDER[newType]!)}
              onChange={e => setNewValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTrigger();
                }
              }}
              className={INPUT}
            />
          )}
          <Button size="sm" variant="glass" onClick={addTrigger} aria-label={t('agents_edit_addTrigger')}>
            <Plus className="size-3.5" aria-hidden />
          </Button>
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('agents_edit_role')} id={id('role')}>
          <select
            id={id('role')}
            value={modelRole}
            onChange={e => setModelRole(e.target.value as AgentProfile['modelRole'])}
            className={INPUT}>
            {AGENT_ROLES.map(role => (
              <option key={role} value={role}>
                {t(ROLE_LABEL[role])}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('agents_edit_workspace')} id={id('workspace')}>
          <select
            id={id('workspace')}
            value={workspaceId}
            onChange={e => setWorkspaceId(e.target.value)}
            className={INPUT}>
            <option value="">{t('agents_edit_noWorkspace')}</option>
            {workspaces.map(workspace => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Field label={t('agents_edit_dailyUsd')} id={id('usd')}>
          <input
            id={id('usd')}
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={dailyUsd}
            placeholder={t('agents_edit_noCap')}
            onChange={e => setDailyUsd(e.target.value)}
            className={INPUT}
          />
        </Field>
        <Field label={t('agents_edit_maxSteps')} id={id('steps')}>
          <input
            id={id('steps')}
            type="number"
            min={1}
            max={200}
            value={maxSteps}
            onChange={e => setMaxSteps(e.target.value)}
            className={INPUT}
          />
        </Field>
        <Field label={t('agents_edit_runsPerDay')} id={id('runs')}>
          <input
            id={id('runs')}
            type="number"
            min={1}
            max={288}
            value={runsPerDay}
            onChange={e => setRunsPerDay(e.target.value)}
            className={INPUT}
          />
        </Field>
      </div>

      <Field label={t('agents_edit_publishes')} hint={t('agents_edit_publishesHint')} id={id('publishes')}>
        <input id={id('publishes')} value={publishes} onChange={e => setPublishes(e.target.value)} className={INPUT} />
      </Field>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px]">{t('agents_edit_inboxResults')}</span>
        <Switch checked={inboxResults} onChange={setInboxResults} label={t('agents_edit_inboxResults')} />
      </div>

      {error && (
        <p role="alert" className="border-destructive/40 bg-destructive/10 rounded-lg border px-2.5 py-1.5 text-[12px]">
          {error}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" disabled={busy}>
          {t('agents_edit_save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t('agents_cancel')}
        </Button>
      </div>
    </form>
  );
}
