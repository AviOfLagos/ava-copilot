import { useState } from 'react';
import { Check, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { t } from '@extension/i18n';
import { FACT_CATEGORIES, FACT_TEXT_MAX, GOAL_TEXT_MAX } from '@extension/storage';
import type { FactCategory, FactSource, UserFact, UserGoal } from '@extension/storage';
import { cn } from '@extension/ui';
import { useAssistantName } from '../hooks/useAssistant';
import type { PanelApi } from '../registry';
import { useWorkspaces } from '../workspaces/WorkspacePicker';
import { useAboutYou } from './useIdentity';

type MessageKey = Parameters<typeof t>[0];

export const INPUT = 'glass w-full rounded-lg px-2 py-1.5 text-[13px] text-foreground outline-none';
export const BUTTON =
  'glass inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-foreground transition-colors hover:bg-accent disabled:opacity-50';
export const ICON_BUTTON =
  'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
export const HINT = 'text-muted-foreground text-[11.5px]';

const CATEGORY_LABELS: Record<FactCategory, MessageKey> = {
  name: 'ava_cat_name',
  role: 'ava_cat_role',
  company: 'ava_cat_company',
  person: 'ava_cat_person',
  preference: 'ava_cat_preference',
  goal: 'ava_cat_goal',
  other: 'ava_cat_other',
};

const SOURCE_LABELS: Record<FactSource, MessageKey> = {
  said: 'ava_source_said',
  confirmed: 'ava_source_confirmed',
  settings: 'ava_source_settings',
};

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

interface FactDraft {
  id?: string;
  text: string;
  category: FactCategory;
  workspaceId: string | null;
}

function FactForm({ api, initial, onDone }: { api: PanelApi; initial: FactDraft; onDone: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const workspaces = useWorkspaces();
  const save = async () => {
    try {
      await api.request({ type: 'identity_fact_save', ...draft });
      onDone();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };
  return (
    <form
      aria-label={initial.id ? t('ava_about_edit_title') : t('ava_about_add')}
      className="flex flex-col gap-2 px-3 py-2.5"
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}>
      <label htmlFor="ava-fact-text" className="text-[13px]">
        {t('ava_about_fact_label')}
      </label>
      <input
        id="ava-fact-text"
        // The form opens on a click meant to type: focus goes straight to the field
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        className={INPUT}
        value={draft.text}
        maxLength={FACT_TEXT_MAX}
        placeholder={t('ava_about_fact_placeholder')}
        onChange={event => setDraft({ ...draft, text: event.target.value })}
        onKeyDown={event => event.key === 'Escape' && onDone()}
      />
      <div className="flex gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px]">
          {t('ava_about_category_label')}
          <select
            className={INPUT}
            value={draft.category}
            onChange={event => setDraft({ ...draft, category: event.target.value as FactCategory })}>
            {FACT_CATEGORIES.map(category => (
              <option key={category} value={category}>
                {t(CATEGORY_LABELS[category])}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px]">
          {t('ava_about_workspace_label')}
          <select
            className={INPUT}
            value={draft.workspaceId ?? ''}
            onChange={event => setDraft({ ...draft, workspaceId: event.target.value || null })}>
            <option value="">{t('ava_about_workspace_none')}</option>
            {workspaces.map(workspace => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} onClick={onDone}>
          {t('ava_cancel')}
        </button>
        <button type="submit" className={cn(BUTTON, 'border-primary/50 bg-primary/15')} disabled={!draft.text.trim()}>
          {t('ava_save')}
        </button>
      </div>
    </form>
  );
}

function FactRow({
  fact,
  workspaceName,
  onEdit,
  api,
}: {
  fact: UserFact;
  workspaceName: string | null;
  onEdit: () => void;
  api: PanelApi;
}) {
  const [deleting, setDeleting] = useState(false);
  const proposed = fact.status === 'proposed';
  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-snug">{fact.text}</div>
        <div className={cn(HINT, 'mt-0.5 flex flex-wrap gap-x-1.5')}>
          <span className="label-mono">{t(CATEGORY_LABELS[fact.category])}</span>
          {workspaceName && <span>· {workspaceName}</span>}
          <span>
            · {day(fact.updatedAt)} · {t(proposed ? 'ava_source_proposed' : SOURCE_LABELS[fact.source])}
          </span>
        </div>
      </div>
      {proposed && (
        <button
          type="button"
          className={cn(BUTTON, 'border-hold/50 bg-hold/15 h-7 px-2')}
          aria-label={t('ava_about_confirm_a11y', [fact.text])}
          onClick={() => void api.request({ type: 'identity_fact_confirm', id: fact.id })}>
          <Check className="size-3.5" aria-hidden />
          {t('ava_about_confirm')}
        </button>
      )}
      {!proposed && (
        <button
          type="button"
          className={ICON_BUTTON}
          aria-label={t('ava_about_edit_a11y', [fact.text])}
          title={t('ava_about_edit_a11y', [fact.text])}
          onClick={onEdit}>
          <Pencil className="size-3.5" />
        </button>
      )}
      <button
        type="button"
        className={cn(ICON_BUTTON, deleting && 'text-destructive bg-destructive/10')}
        aria-label={deleting ? t('ava_delete_confirm') : t('ava_about_delete_a11y', [fact.text])}
        title={deleting ? t('ava_delete_confirm') : t('ava_about_delete_a11y', [fact.text])}
        onBlur={() => setDeleting(false)}
        onClick={() => {
          if (!deleting) return setDeleting(true);
          void api.request({ type: 'identity_fact_delete', id: fact.id });
        }}>
        <Trash2 className="size-3.5" />
      </button>
    </li>
  );
}

function GoalsBlock({ api, goals }: { api: PanelApi; goals: UserGoal[] }) {
  const workspaces = useWorkspaces();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const nameOf = (id: string | null) => workspaces.find(workspace => workspace.id === id)?.name ?? null;
  const add = async () => {
    if (!text.trim()) return;
    await api.request({ type: 'identity_goal_save', text, workspaceId });
    setText('');
    setAdding(false);
  };
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="text-[13px]">{t('ava_goals_title')}</div>
      {goals.length === 0 && <p className={HINT}>{t('ava_goals_empty')}</p>}
      <ul aria-label={t('ava_goals_title')} className="flex flex-col gap-1">
        {goals.map(goal => (
          <li key={goal.id} className="flex items-center gap-2 text-[12.5px]">
            <span className="min-w-0 flex-1">
              {goal.text}
              <span className={cn(HINT, 'ml-1.5')}>
                {nameOf(goal.workspaceId) ? `${nameOf(goal.workspaceId)} · ` : ''}
                {t(goal.source === 'user' ? 'ava_goal_yours' : 'ava_goal_fromReflection')}
              </span>
            </span>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={t('ava_goal_delete_a11y', [goal.text])}
              title={t('ava_goal_delete_a11y', [goal.text])}
              onClick={() => void api.request({ type: 'identity_goal_delete', id: goal.id })}>
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <form
          aria-label={t('ava_goals_add')}
          className="flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault();
            void add();
          }}>
          <input
            aria-label={t('ava_goals_add')}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className={INPUT}
            value={text}
            maxLength={GOAL_TEXT_MAX}
            placeholder={t('ava_goal_placeholder')}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => event.key === 'Escape' && setAdding(false)}
          />
          {workspaces.length > 0 && (
            <select
              aria-label={t('ava_about_workspace_label')}
              className={INPUT}
              value={workspaceId ?? ''}
              onChange={event => setWorkspaceId(event.target.value || null)}>
              <option value="">{t('ava_about_workspace_none')}</option>
              {workspaces.map(workspace => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON} onClick={() => setAdding(false)}>
              {t('ava_cancel')}
            </button>
            <button type="submit" className={cn(BUTTON, 'border-primary/50 bg-primary/15')} disabled={!text.trim()}>
              {t('ava_save')}
            </button>
          </div>
        </form>
      ) : (
        <div>
          <button type="button" className={BUTTON} onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            {t('ava_goals_add')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Settings › About you: what the assistant knows about the user (facts with their dates and source), the ones
 * waiting for the user's OK, their current goals, and what the last reflection noticed.
 */
export default function AboutYouSettings({ api }: { api: PanelApi }) {
  const state = useAboutYou();
  const name = useAssistantName();
  const workspaces = useWorkspaces();
  const [editing, setEditing] = useState<FactDraft | null>(null);
  const [reflecting, setReflecting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const nameOf = (id: string | null) => workspaces.find(workspace => workspace.id === id)?.name ?? null;
  const proposed = state.facts.filter(fact => fact.status === 'proposed');
  const active = [...state.facts.filter(fact => fact.status === 'active')].sort((a, b) => b.updatedAt - a.updatedAt);

  const reflect = async () => {
    setReflecting(true);
    setNote(null);
    try {
      const reply = await api.request<{ skipped?: string }>({ type: 'identity_reflect_now' }, 120_000);
      if (reply.skipped) setNote(t('ava_reflect_skipped'));
    } catch (problem) {
      setNote(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setReflecting(false);
    }
  };

  if (editing) return <FactForm api={api} initial={editing} onDone={() => setEditing(null)} />;

  return (
    <>
      <p className={cn(HINT, 'px-3 py-2.5')}>{t('ava_about_hint', [name])}</p>
      {proposed.length > 0 && (
        <div className="py-1">
          <div className="px-3 pt-1.5 text-[13px]">{t('ava_about_proposed_title')}</div>
          <p className={cn(HINT, 'px-3')}>{t('ava_about_proposed_hint', [name])}</p>
          <ul aria-label={t('ava_about_proposed_title')}>
            {proposed.map(fact => (
              <FactRow key={fact.id} api={api} fact={fact} workspaceName={nameOf(fact.workspaceId)} onEdit={() => {}} />
            ))}
          </ul>
        </div>
      )}
      <div className="py-1">
        {active.length === 0 ? (
          <p className={cn(HINT, 'px-3 py-1.5')}>{t('ava_about_empty', [name])}</p>
        ) : (
          <ul aria-label={t('ava_about_list_label', [name])}>
            {active.map(fact => (
              <FactRow
                key={fact.id}
                api={api}
                fact={fact}
                workspaceName={nameOf(fact.workspaceId)}
                onEdit={() =>
                  setEditing({ id: fact.id, text: fact.text, category: fact.category, workspaceId: fact.workspaceId })
                }
              />
            ))}
          </ul>
        )}
        <div className="px-3 py-1.5">
          <button
            type="button"
            className={BUTTON}
            onClick={() => setEditing({ text: '', category: 'other', workspaceId: null })}>
            <Plus className="size-3.5" />
            {t('ava_about_add')}
          </button>
        </div>
      </div>
      <GoalsBlock api={api} goals={state.goals} />
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        {state.insights.length > 0 && (
          <>
            <div className="text-[13px]">{t('ava_insights_title')}</div>
            <ul className="text-muted-foreground flex list-disc flex-col gap-0.5 pl-4 text-[12px]">
              {state.insights.slice(0, 4).map(insight => (
                <li key={insight.id}>{insight.text}</li>
              ))}
            </ul>
          </>
        )}
        <div className="flex items-center gap-2">
          <span className={cn(HINT, 'min-w-0 flex-1')}>
            {state.lastReflectionAt
              ? t('ava_reflect_last', [new Date(state.lastReflectionAt).toLocaleString()])
              : t('ava_reflect_never')}
          </span>
          <button type="button" className={BUTTON} disabled={reflecting} onClick={() => void reflect()}>
            <Sparkles className="size-3.5" aria-hidden />
            {reflecting ? t('ava_reflect_running') : t('ava_reflect_now')}
          </button>
        </div>
        {note && (
          <p role="status" className={HINT}>
            {note}
          </p>
        )}
      </div>
    </>
  );
}
