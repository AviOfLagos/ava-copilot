import { useState } from 'react';
import { t } from '@extension/i18n';
import { taskStore } from '@extension/storage';
import type { Task } from '@extension/storage';
import { cn } from '@extension/ui';
import { useLive } from '../hooks/useLive';
import { setTaskStatus } from './client';

const LOADING = 'loading' as const;

/** "21 Nov, 14:02". */
function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Who closed a task and when, for the hover. */
export function closedLine(task: Pick<Task, 'status' | 'doneAt' | 'doneBy'>): string {
  if (task.status === 'open' || !task.doneAt) return '';
  const who = task.doneBy === 'ava' ? t('tasks_who_ava') : t('tasks_who_avi');
  return t(task.status === 'done' ? 'tasks_doneBy' : 'tasks_droppedBy', [who, when(task.doneAt)]);
}

/** A plain box that does nothing, for a line no code vouched for or a task that is gone. */
export function DeadCheckbox({ text, checked = false }: { text: string; checked?: boolean }) {
  return (
    <span className="flex items-start gap-2">
      <input type="checkbox" disabled checked={checked} readOnly className="mt-1 size-3.5 shrink-0" aria-hidden />
      <span>{text}</span>
    </span>
  );
}

/**
 * A task's checkbox, drawn from the board every time: an old brief shows today's state. A click closes the task, a
 * second one reopens it. A done task is struck through, with who closed it and when on hover.
 *
 * @param fallback - What to show while the task loads, or if it no longer exists (then the box does nothing)
 * @param meta - Show the owner and the due date after the title
 */
export function TaskCheckbox({
  taskId,
  fallback,
  meta = true,
  className,
}: {
  taskId: string;
  fallback: string;
  meta?: boolean;
  className?: string;
}) {
  const task = useLive<Task | null | typeof LOADING>(
    async () => (await taskStore.get(taskId)) ?? null,
    [taskId],
    LOADING,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (task === LOADING || task === null) return <DeadCheckbox text={fallback} />;

  const closed = task.status !== 'open';
  const toggle = async () => {
    setBusy(true);
    setError('');
    try {
      await setTaskStatus(task.id, closed ? 'open' : 'done');
    } catch {
      setError(t('tasks_error_toggle'));
    } finally {
      setBusy(false);
    }
  };
  const details = [task.ownerName, task.due ? t('tasks_due', [task.due]) : ''].filter(Boolean).join(' · ');

  return (
    <span className={cn('flex flex-col', className)} data-task-id={task.id} data-task-status={task.status}>
      <label className="flex cursor-pointer items-start gap-2" title={closedLine(task) || undefined}>
        <input
          type="checkbox"
          className="accent-primary mt-1 size-3.5 shrink-0 cursor-pointer"
          checked={closed}
          disabled={busy}
          onChange={() => void toggle()}
          aria-label={t(closed ? 'tasks_toggle_reopen' : 'tasks_toggle_done', [task.title])}
        />
        <span className={cn(closed && 'text-muted-foreground line-through')}>
          {task.title}
          {meta && details && <span className="text-muted-foreground"> ({details})</span>}
        </span>
      </label>
      {error && (
        <span role="alert" className="text-destructive pl-5 text-[12px]">
          {error}
        </span>
      )}
    </span>
  );
}
