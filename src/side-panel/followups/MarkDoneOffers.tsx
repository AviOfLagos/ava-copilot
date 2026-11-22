import { useState } from 'react';
import { t } from '@extension/i18n';
import { db, stripTaskMarkers, taskStore } from '@extension/storage';
import type { MarkDoneOffer, PersonUpdate, Task } from '@extension/storage';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import type { TurnAddonProps } from '../registry';
import { followupsRequest } from './client';

const LOADING = 'loading' as const;
const oneLine = (text: string) => stripTaskMarkers(text.replace(/\s+/g, ' ').trim());

/** "Ada said: sent the login. Mark 'Send the login' done?" with its two answers; an answered one shows its answer. */
export function MarkDoneLine({ update, offer }: { update: Pick<PersonUpdate, 'id' | 'name'>; offer: MarkDoneOffer }) {
  const task = useLive<Task | null | typeof LOADING>(
    async () => (await taskStore.get(offer.taskId)) ?? null,
    [offer.taskId],
    LOADING,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A task dropped since is no question any more
  if (task === LOADING || task === null || (task.status === 'dropped' && !offer.answer)) return null;
  const title = oneLine(task.title);
  const answered = offer.answer ?? (task.status === 'done' ? 'done' : undefined);

  const answer = async (value: 'done' | 'no') => {
    setBusy(true);
    setError('');
    try {
      await followupsRequest({ type: 'followups_mark_done', updateId: update.id, taskId: offer.taskId, answer: value });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t('followups_error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-1.5 px-1 py-1.5" data-testid="markdone-offer" data-task={offer.taskId}>
      <p className="text-[12.5px] leading-snug">
        {t('followups_md_ask', [oneLine(update.name), oneLine(offer.said).slice(0, 200), title])}
      </p>
      {answered ? (
        <p className="text-muted-foreground text-[11.5px]" data-testid="markdone-answered">
          {t(answered === 'done' ? 'followups_md_answered_done' : 'followups_md_answered_no')}
        </p>
      ) : (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="hold"
            data-testid="markdone-yes"
            disabled={busy}
            onClick={() => void answer('done')}>
            {t('followups_md_yes')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="markdone-no"
            disabled={busy}
            onClick={() => void answer('no')}>
            {t('followups_md_no')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-[11.5px]">
          {error}
        </p>
      )}
    </li>
  );
}

/** Every "Mark done?" a call's updates hold. Nothing when it has none. */
export function MarkDoneOffers({ meetingId }: { meetingId: string }) {
  const updates = useLive(
    () => db.personUpdates.where('source.id').equals(meetingId).toArray(),
    [meetingId],
    [] as PersonUpdate[],
  );
  const lines = updates
    .filter(update => update.source.kind === 'meeting')
    .flatMap(update => (update.offers ?? []).map(offer => ({ update, offer })));
  if (lines.length === 0) return null;
  return (
    <section className="glass rounded-xl px-3 py-2.5" aria-label={t('followups_md_title')} data-testid="markdone-card">
      <h2 className="text-[13px] font-semibold">{t('followups_md_title')}</h2>
      <ul className="divide-border/60 flex flex-col divide-y">
        {lines.map(({ update, offer }) => (
          <MarkDoneLine key={`${update.id}|${offer.taskId}`} update={update} offer={offer} />
        ))}
      </ul>
    </section>
  );
}

/** Under a meeting's note in its chat: the "Mark done?" questions that call raised. */
export function MeetingMarkDone({ thread, requestSeq }: TurnAddonProps) {
  if (!thread.meetingId || requestSeq !== null) return null;
  return <MarkDoneOffers meetingId={thread.meetingId} />;
}
