import { useEffect, useState } from 'react';
import { Check, Copy, MessageCircle } from 'lucide-react';
import { t } from '@extension/i18n';
import { isoDay, peopleStore, stripTaskMarkers, taskStore } from '@extension/storage';
import type { Task } from '@extension/storage';
import { cn } from '@extension/ui';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import { setTaskStatus } from '../tasks/client';
import { dayShort, followupsRequest, isoDayShort } from './client';
import type { DraftReply } from './client';

const LOADING = 'loading' as const;
const MAX_TEXT = 1000;
const SNOOZES = [1, 3, 7] as const;

/** "Why today" in a few words, worked out from the task as it is now. */
function whyToday(task: Task, now: number): string {
  if (task.due && task.due < isoDay(now)) return t('followups_card_why_overdue', [isoDayShort(task.due)]);
  const follow = task.followUp;
  if (follow?.nextBy === 'asked' && follow.askedAt) return t('followups_card_why_asked', [dayShort(follow.askedAt)]);
  if (follow?.nextBy === 'snooze') return t('followups_card_why_snoozed');
  if (follow?.nextBy === 'update') return t('followups_card_why_update');
  return t('followups_card_why_quiet');
}

const oneLine = (text: string) => stripTaskMarkers(text.replace(/\s+/g, ' ').trim());

/**
 * One follow-up (docs/pm-desk.md, Part 9.3): who, what, why today, and the message ready to copy or to type into
 * WhatsApp. Every state is drawn from the task each time, so an old brief shows what is true now. Nothing here sends.
 */
export function FollowUpCard({ taskId }: { taskId: string }) {
  const task = useLive<Task | null | typeof LOADING>(
    async () => (await taskStore.get(taskId)) ?? null,
    [taskId],
    LOADING,
  );
  const person = useLive(
    async () => (task && task !== LOADING && task.ownerId ? ((await peopleStore.get(task.ownerId)) ?? null) : null),
    [task === LOADING || !task ? '' : task.ownerId],
    null,
  );
  const [text, setText] = useState('');
  const [drafting, setDrafting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const open = task !== LOADING && task !== null && task.status === 'open';

  useEffect(() => {
    if (!open) return;
    let live = true;
    setDrafting(true);
    followupsRequest<DraftReply>({ type: 'followups_draft', taskId })
      .then(reply => live && setText(reply.text))
      .catch(problem => live && setError(problem instanceof Error ? problem.message : t('followups_error')))
      .finally(() => live && setDrafting(false));
    return () => {
      live = false;
    };
  }, [taskId, open]);

  if (task === LOADING) return <div data-testid="followup-card" data-task={taskId} />;
  if (task === null) {
    return (
      <div className="glass rounded-xl px-3 py-2.5" data-testid="followup-card" data-task={taskId}>
        <p className="text-muted-foreground text-[12.5px]">{t('followups_card_gone')}</p>
      </div>
    );
  }

  const name = oneLine(person?.name || task.ownerName || '');
  const title = oneLine(task.title);
  const now = Date.now();
  const next = task.followUp?.nextAt;
  const waiting = open && next !== undefined && next > now;

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await run();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t('followups_error'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t('followups_card_copy_fail'));
    }
  };

  return (
    <section
      className="glass flex flex-col gap-2 rounded-xl px-3 py-2.5"
      aria-label={t('followups_card_a11y', [name])}
      data-testid="followup-card"
      data-task={taskId}>
      <header className="min-w-0">
        <p className={cn('text-[13px] font-medium', !open && 'text-muted-foreground line-through')}>
          {name && <span>{name}: </span>}
          {title}
        </p>
        {open && <p className="text-muted-foreground text-[11.5px]">{whyToday(task, now)}</p>}
        {!open && (
          <p className="text-muted-foreground text-[11.5px]" data-testid="followup-state">
            {t('followups_card_closed')}
          </p>
        )}
      </header>

      {open && (
        <>
          <textarea
            aria-label={t('followups_card_draft_a11y', [name])}
            data-testid="followup-draft"
            value={drafting ? '' : text}
            placeholder={drafting ? t('followups_card_drafting') : undefined}
            maxLength={MAX_TEXT}
            rows={3}
            onChange={event => setText(event.target.value)}
            className="bg-secondary text-secondary-foreground w-full resize-y rounded-lg px-2 py-1.5 text-[12.5px] leading-snug"
          />
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="glass"
              data-testid="followup-copy"
              disabled={!text.trim()}
              onClick={() => void copy()}>
              {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {copied ? t('followups_card_copied') : t('followups_card_copy')}
            </Button>
            {!waiting && (
              <Button
                size="sm"
                variant="glass"
                data-testid="followup-whatsapp"
                disabled={busy || !text.trim()}
                onClick={() =>
                  void act(async () => {
                    const { chat } = await followupsRequest<{ chat: string }>({
                      type: 'followups_draft_whatsapp',
                      taskId,
                      text,
                    });
                    setNote(t('followups_card_whatsapp_done', [chat]));
                  })
                }>
                <MessageCircle className="size-3.5" aria-hidden />
                {t('followups_card_whatsapp')}
              </Button>
            )}
          </div>

          {waiting && (
            <p className="text-muted-foreground text-[12px]" data-testid="followup-state">
              {task.followUp?.nextBy === 'snooze'
                ? t('followups_card_state_snoozed', [dayShort(next)])
                : t('followups_card_state_asked', [dayShort(next)])}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {!waiting && (
              <Button
                size="sm"
                variant="hold"
                data-testid="followup-asked"
                disabled={busy}
                onClick={() => void act(() => followupsRequest({ type: 'followups_asked', taskId }))}>
                {t('followups_card_asked')}
              </Button>
            )}
            <Button
              size="sm"
              variant="hold"
              data-testid="followup-done"
              disabled={busy}
              onClick={() => void act(() => setTaskStatus(taskId, 'done'))}>
              {t('followups_card_done')}
            </Button>
            {!waiting &&
              SNOOZES.map(days => (
                <Button
                  key={days}
                  size="sm"
                  variant="ghost"
                  data-testid={`followup-snooze-${days}`}
                  disabled={busy}
                  onClick={() => void act(() => followupsRequest({ type: 'followups_snooze', taskId, days }))}>
                  {t(
                    days === 1
                      ? 'followups_card_snooze_1'
                      : days === 3
                        ? 'followups_card_snooze_3'
                        : 'followups_card_snooze_7',
                  )}
                </Button>
              ))}
          </div>
        </>
      )}
      {note && <p className="text-muted-foreground text-[12px]">{note}</p>}
      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
    </section>
  );
}
