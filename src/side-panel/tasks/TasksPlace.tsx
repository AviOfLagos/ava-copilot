import { useMemo, useState } from 'react';
import { MoreHorizontal, Plus } from 'lucide-react';
import { t } from '@extension/i18n';
import { byDueThenAge, db, OLD_TASK_AGE, taskStore } from '@extension/storage';
import type { Task, TaskStatus, Workspace } from '@extension/storage';
import { Button } from '../components/ui/button';
import { RowMenu, RowMenuContent, RowMenuItem, RowMenuSeparator, RowMenuTrigger } from '../components/ui/row-menu';
import { useLive } from '../hooks/useLive';
import type { PanelApi } from '../registry';
import { useWorkspaces } from '../workspaces/WorkspacePicker';
import { tasksRequest } from './client';
import { TaskCheckbox } from './TaskCheckbox';
import { groupTasks } from './group';
import type { Grouping } from './group';

type MessageKey = Parameters<typeof t>[0];

const NO_WORKSPACE = '__none__';

const SOURCE_LABELS: Record<Task['source']['kind'], MessageKey> = {
  meeting: 'tasks_from_meeting',
  chat: 'tasks_from_chat',
  voice: 'tasks_from_voice',
  manual: 'tasks_from_manual',
  note: 'tasks_from_note',
  summary: 'tasks_from_summary',
  whatsapp: 'tasks_from_whatsapp',
};

const inputClass =
  'bg-card text-foreground placeholder:text-muted-foreground border-border focus:border-primary/50 h-8 min-w-0 rounded-lg border px-2.5 text-[13px] outline-none';

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? 'bg-primary/15 border-primary/50 text-foreground rounded-full border px-2.5 py-1 text-[11.5px] font-medium'
          : 'glass text-muted-foreground rounded-full px-2.5 py-1 text-[11.5px]'
      }>
      {label}
    </button>
  );
}

function WorkspaceSelect({
  value,
  onChange,
  workspaces,
  label,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  workspaces: Workspace[];
  label: string;
}) {
  return (
    <select
      aria-label={label}
      className={inputClass}
      value={value ?? NO_WORKSPACE}
      onChange={event => onChange(event.target.value === NO_WORKSPACE ? null : event.target.value)}>
      {workspaces.map(workspace => (
        <option key={workspace.id} value={workspace.id}>
          {workspace.name}
        </option>
      ))}
      <option value={NO_WORKSPACE}>{t('tasks_noWorkspace')}</option>
    </select>
  );
}

/** "Add task": the words, the workspace, who and when. */
function AddForm({ workspaces, onDone }: { workspaces: Workspace[]; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [workspaceId, setWorkspaceId] = useState<string | null>(workspaces[0]?.id ?? null);
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    if (!title.trim()) return;
    try {
      await tasksRequest({ type: 'tasks_add', title, workspaceId, ownerName: owner, due });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <form
      className="glass flex flex-col gap-2 rounded-xl p-2.5"
      aria-label={t('tasks_add')}
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}>
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        className={inputClass}
        placeholder={t('tasks_add_placeholder')}
        aria-label={t('tasks_add_placeholder')}
        value={title}
        onChange={event => setTitle(event.target.value)}
        onKeyDown={event => event.key === 'Escape' && onDone()}
      />
      <div className="grid grid-cols-2 gap-2">
        <WorkspaceSelect
          value={workspaceId}
          onChange={setWorkspaceId}
          workspaces={workspaces}
          label={t('tasks_workspace')}
        />
        <input
          className={inputClass}
          placeholder={t('tasks_owner_placeholder')}
          aria-label={t('tasks_owner_placeholder')}
          value={owner}
          onChange={event => setOwner(event.target.value)}
        />
        <input
          type="date"
          className={inputClass}
          aria-label={t('tasks_due_label')}
          value={due}
          onChange={event => setDue(event.target.value)}
        />
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            {t('tasks_cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={!title.trim()}>
            {t('tasks_add_submit')}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
    </form>
  );
}

type Editing = 'edit' | 'owner' | 'merge' | null;

/** One task: its box, who and when, where it came from, and its menu. */
function TaskRow({
  task,
  others,
  workspaces,
  api,
}: {
  task: Task;
  others: Task[];
  workspaces: Workspace[];
  api: PanelApi;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [title, setTitle] = useState(task.title);
  const [owner, setOwner] = useState(task.ownerName ?? '');
  const [due, setDue] = useState(task.due ?? '');
  const [mergeId, setMergeId] = useState('');
  const [error, setError] = useState('');

  const run = async (message: Parameters<typeof tasksRequest>[0]) => {
    setError('');
    try {
      await tasksRequest(message);
      setEditing(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const openSource = async () => {
    const id = task.source.id;
    if (!id) return;
    if (task.source.kind === 'meeting') {
      const meeting = await db.meetings.get(id);
      if (meeting?.threadId) api.openThread(meeting.threadId);
    } else if (task.source.kind === 'chat' && (await db.threads.get(id))) {
      api.openThread(id);
    }
  };
  const linked = !!task.source.id && (task.source.kind === 'meeting' || task.source.kind === 'chat');
  const details = [task.ownerName, task.due ? t('tasks_due', [task.due]) : ''].filter(Boolean).join(' · ');

  return (
    <li className="glass flex flex-col gap-1 rounded-xl px-2.5 py-2" aria-label={task.title}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-[13px]">
          <TaskCheckbox taskId={task.id} fallback={task.title} meta={false} />
        </div>
        <RowMenu>
          <RowMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('tasks_menu', [task.title])}>
              <MoreHorizontal className="size-3.5" />
            </Button>
          </RowMenuTrigger>
          <RowMenuContent>
            <RowMenuItem onSelect={() => setEditing('edit')}>{t('tasks_edit')}</RowMenuItem>
            <RowMenuItem onSelect={() => setEditing('owner')}>{t('tasks_give')}</RowMenuItem>
            {others.length > 0 && <RowMenuItem onSelect={() => setEditing('merge')}>{t('tasks_merge')}</RowMenuItem>}
            <RowMenuSeparator />
            {workspaces
              .filter(workspace => workspace.id !== task.workspaceId)
              .map(workspace => (
                <RowMenuItem
                  key={workspace.id}
                  onSelect={() => void run({ type: 'tasks_move', ids: [task.id], workspaceId: workspace.id })}>
                  {t('tasks_moveTo', [workspace.name])}
                </RowMenuItem>
              ))}
            {task.workspaceId !== null && (
              <RowMenuItem onSelect={() => void run({ type: 'tasks_move', ids: [task.id], workspaceId: null })}>
                {t('tasks_moveTo', [t('tasks_noWorkspace')])}
              </RowMenuItem>
            )}
            {task.status !== 'dropped' && (
              <>
                <RowMenuSeparator />
                <RowMenuItem
                  destructive
                  onSelect={() => void run({ type: 'tasks_set_status', id: task.id, status: 'dropped' })}>
                  {t('tasks_drop')}
                </RowMenuItem>
              </>
            )}
          </RowMenuContent>
        </RowMenu>
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-2 pl-5 text-[11.5px]">
        {details && <span>{details}</span>}
        {linked ? (
          <button
            type="button"
            className="hover:text-foreground underline-offset-2 hover:underline"
            onClick={() => void openSource()}>
            {t(SOURCE_LABELS[task.source.kind])}
          </button>
        ) : (
          <span>{t(SOURCE_LABELS[task.source.kind])}</span>
        )}
        {task.seenIn.length > 1 && <span>{t('tasks_seenIn', [String(task.seenIn.length)])}</span>}
      </div>

      {editing === 'edit' && (
        <form
          className="flex flex-col gap-1.5 pl-5"
          onSubmit={event => {
            event.preventDefault();
            void run({ type: 'tasks_update', id: task.id, title, ownerName: owner, due });
          }}>
          <input
            className={inputClass}
            aria-label={t('tasks_add_placeholder')}
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <input
              className={inputClass}
              aria-label={t('tasks_owner_placeholder')}
              placeholder={t('tasks_owner_placeholder')}
              value={owner}
              onChange={e => setOwner(e.target.value)}
            />
            <input
              type="date"
              className={inputClass}
              aria-label={t('tasks_due_label')}
              value={due}
              onChange={e => setDue(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
              {t('tasks_cancel')}
            </Button>
            <Button type="submit" size="sm">
              {t('tasks_save')}
            </Button>
          </div>
        </form>
      )}
      {editing === 'owner' && (
        <form
          className="flex gap-1.5 pl-5"
          onSubmit={event => {
            event.preventDefault();
            void run({ type: 'tasks_update', id: task.id, ownerName: owner });
          }}>
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className={`${inputClass} flex-1`}
            aria-label={t('tasks_owner_placeholder')}
            placeholder={t('tasks_owner_placeholder')}
            value={owner}
            onChange={e => setOwner(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && setEditing(null)}
          />
          <Button type="submit" size="sm">
            {t('tasks_save')}
          </Button>
        </form>
      )}
      {editing === 'merge' && (
        <form
          className="flex flex-col gap-1.5 pl-5"
          onSubmit={event => {
            event.preventDefault();
            if (mergeId) void run({ type: 'tasks_merge', keepId: task.id, dropId: mergeId });
          }}>
          <label className="text-muted-foreground text-[11.5px]" htmlFor={`merge-${task.id}`}>
            {t('tasks_merge_pick')}
          </label>
          <select
            id={`merge-${task.id}`}
            className={inputClass}
            value={mergeId}
            onChange={e => setMergeId(e.target.value)}>
            <option value="">—</option>
            {others.map(other => (
              <option key={other.id} value={other.id}>
                {other.title}
              </option>
            ))}
          </select>
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
              {t('tasks_cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!mergeId}>
              {t('tasks_merge_submit')}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-destructive pl-5 text-[12px]">
          {error}
        </p>
      )}
    </li>
  );
}

const EMPTY: Record<TaskStatus, MessageKey> = {
  open: 'tasks_empty_open',
  done: 'tasks_empty_done',
  dropped: 'tasks_empty_dropped',
};

/** The Tasks page: every task on the board, by workspace or by person, open, done or dropped. */
export default function TasksPlace({ api }: { api: PanelApi }) {
  const workspaces = useWorkspaces();
  const tasks = useLive(() => taskStore.list(), [], [] as Task[]);
  const [status, setStatus] = useState<TaskStatus>('open');
  const [grouping, setGrouping] = useState<Grouping>('workspace');
  const [adding, setAdding] = useState(false);
  const [confirmOld, setConfirmOld] = useState(false);
  const [error, setError] = useState('');

  const shown = useMemo(() => tasks.filter(task => task.status === status).sort(byDueThenAge), [tasks, status]);
  const groups = useMemo(
    () => groupTasks(shown, grouping, workspaces, { noWorkspace: t('tasks_noWorkspace'), noOwner: t('tasks_noOwner') }),
    [shown, grouping, workspaces],
  );
  // Read at render: "older than two weeks" moves with the clock
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const old = tasks.filter(task => task.status === 'open' && task.updatedAt < now - OLD_TASK_AGE).length;

  const closeOld = async () => {
    setError('');
    try {
      await tasksRequest({ type: 'tasks_close_old' });
      setConfirmOld(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <section aria-label={t('tasks_title')} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">{t('tasks_title')}</h2>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            {t('tasks_add')}
          </Button>
        )}
      </div>
      {adding && <AddForm workspaces={workspaces} onDone={() => setAdding(false)} />}

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip
          active={grouping === 'workspace'}
          label={t('tasks_byWorkspace')}
          onClick={() => setGrouping('workspace')}
        />
        <Chip active={grouping === 'person'} label={t('tasks_byPerson')} onClick={() => setGrouping('person')} />
        <span className="bg-border/60 mx-1 h-4 w-px" aria-hidden />
        {(['open', 'done', 'dropped'] as const).map(value => (
          <Chip
            key={value}
            active={status === value}
            label={t(`tasks_status_${value}`)}
            onClick={() => setStatus(value)}
          />
        ))}
      </div>

      {old > 0 && status === 'open' && (
        <div className="glass flex flex-col gap-1.5 rounded-xl px-3 py-2 text-[12.5px]" role="status">
          {confirmOld ? (
            <>
              <span>{t('tasks_old_confirm', [String(old)])}</span>
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => void closeOld()}>
                  {t('tasks_old_yes')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmOld(false)}>
                  {t('tasks_cancel')}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span>{t('tasks_old_banner', [String(old)])}</span>
              <Button size="sm" variant="glass" onClick={() => setConfirmOld(true)}>
                {t('tasks_old_action')}
              </Button>
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">{t(EMPTY[status])}</p>
      ) : (
        groups.map(group => (
          <section key={group.key} aria-label={group.name} className="flex flex-col gap-1.5">
            <h3 className="label-mono">
              {group.name} <span className="text-muted-foreground">({group.tasks.length})</span>
            </h3>
            <ul className="flex flex-col gap-1.5">
              {group.tasks.map(task => (
                <TaskRow
                  key={task.id}
                  task={task}
                  others={shown.filter(other => other.id !== task.id && other.workspaceId === task.workspaceId)}
                  workspaces={workspaces}
                  api={api}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
