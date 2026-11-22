import { useState } from 'react';
import { t } from '@extension/i18n';
import type { Task } from '@extension/storage';
import { Button } from '../components/ui/button';

/**
 * Sends a command to the background, which is the only writer (src/background/call-tasks, src/background/tasks).
 * Resolves with the reply, rejects with the background's error.
 */
export async function callTasksRequest<T = Record<string, unknown>>(message: Record<string, unknown>): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() })) as
    (T & { type?: string; error?: string }) | undefined;
  if (!reply) throw new Error(t('errors_unknown'));
  if (reply.type === 'error') throw new Error(reply.error || t('errors_unknown'));
  return reply;
}

/** A task's words, with Edit and Discard. Edit changes the words (and, with `withOwner`, who it is for). */
export function TaskWords({
  task,
  withOwner = false,
  locked = false,
}: {
  task: Pick<Task, 'id' | 'title' | 'detail' | 'ownerName'>;
  withOwner?: boolean;
  // After "Looks right" the words went out: they stay as they were
  locked?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [owner, setOwner] = useState(task.ownerName ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (message: Record<string, unknown>) => {
    setError('');
    setBusy(true);
    try {
      await callTasksRequest(message);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const changes: Record<string, unknown> = {};
    if (title.trim() && title.trim() !== task.title) changes.title = title.trim();
    if (withOwner && owner.trim() !== (task.ownerName ?? '')) changes.ownerName = owner.trim();
    if (Object.keys(changes).length && !(await act({ type: 'tasks_update', id: task.id, ...changes }))) return;
    setEditing(false);
  };

  if (editing) {
    return (
      <form
        className="flex flex-col gap-1.5"
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}>
        <input
          className="bg-background/60 border-border rounded-md border px-2 py-1 text-[13px]"
          aria-label={t('calltasks_edit_words')}
          value={title}
          maxLength={200}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onChange={event => setTitle(event.target.value)}
          onKeyDown={event => event.key === 'Escape' && setEditing(false)}
        />
        {withOwner && (
          <input
            className="bg-background/60 border-border rounded-md border px-2 py-1 text-[13px]"
            aria-label={t('calltasks_edit_owner')}
            placeholder={t('calltasks_edit_owner')}
            value={owner}
            maxLength={80}
            onChange={event => setOwner(event.target.value)}
          />
        )}
        <div className="flex gap-1">
          <Button size="sm" type="submit" disabled={busy}>
            {t('calltasks_save')}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
            {t('calltasks_cancel')}
          </Button>
        </div>
        {error && <p className="text-destructive text-[11.5px]">{error}</p>}
      </form>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[13px] leading-snug" data-calltask-title>
        {task.title}
      </p>
      {task.detail && (
        <p className="text-muted-foreground whitespace-pre-line text-[12px] leading-snug" data-calltask-detail>
          {task.detail}
        </p>
      )}
      {!locked && (
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('calltasks_edit_for', [task.title])}
            onClick={() => {
              setTitle(task.title);
              setOwner(task.ownerName ?? '');
              setEditing(true);
            }}>
            {t('calltasks_edit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={t('calltasks_discard_for', [task.title])}
            onClick={() => void act({ type: 'tasks_set_status', id: task.id, status: 'dropped' })}>
            {t('calltasks_discard')}
          </Button>
        </div>
      )}
      {error && <p className="text-destructive text-[11.5px]">{error}</p>}
    </div>
  );
}
