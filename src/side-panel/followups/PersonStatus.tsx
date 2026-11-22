import { useState } from 'react';
import { t } from '@extension/i18n';
import { db, stripTaskMarkers } from '@extension/storage';
import type { PersonUpdate, Task } from '@extension/storage';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import { dayShort, followupsRequest, isoDayShort } from './client';
import { MarkDoneLine } from './MarkDoneOffers';

const oneLine = (text: string) => stripTaskMarkers(text.replace(/\s+/g, ' ').trim());

/** The latest update of a person and their open tasks, read live. */
function usePersonStatus(personId: string) {
  const updates = useLive(
    async () => (await db.personUpdates.where('personId').equals(personId).toArray()).sort((a, b) => b.at - a.at),
    [personId],
    [] as PersonUpdate[],
  );
  const tasks = useLive(
    async () => (await db.tasks.where('ownerId').equals(personId).toArray()).filter(task => task.status === 'open'),
    [personId],
    [] as Task[],
  );
  return { latest: updates[0] ?? null, tasks };
}

/** One line for a closed row: "Doing: finishing the login". */
export function PersonStatusSummary({ personId }: { personId: string }) {
  const { latest } = usePersonStatus(personId);
  const doing = latest?.doing.map(oneLine).filter(Boolean).join('; ');
  if (!doing) return null;
  return (
    <span className="text-muted-foreground block truncate text-[11.5px]" data-testid="person-status-doing">
      {t('followups_ps_summary', [doing])}
    </span>
  );
}

function Lines({ label, items, testId }: { label: string; items: string[]; testId?: string }) {
  const lines = items.map(oneLine).filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <div data-testid={testId}>
      <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">{label}</p>
      <ul className="list-disc pl-4 text-[12.5px] leading-snug">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** A person's status: their latest update, open tasks, the "Mark done?" questions and a place to say what they said. */
export function PersonStatus({ personId, name }: { personId: string; name?: string }) {
  const { latest, tasks } = usePersonStatus(personId);
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await followupsRequest({ type: 'followups_report', personId, words: words.trim() });
      setWords('');
      setSaved(true);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t('followups_error'));
    } finally {
      setBusy(false);
    }
  };

  const from = latest
    ? t(
        latest.source.kind === 'meeting'
          ? 'followups_ps_from_meeting'
          : latest.source.kind === 'whatsapp'
            ? 'followups_ps_from_whatsapp'
            : 'followups_ps_from_manual',
      )
    : '';
  const by = latest?.by ? isoDayShort(latest.by) : latest?.byText ? oneLine(latest.byText) : '';
  const offers = (latest?.offers ?? []).filter(offer => !offer.answer);

  return (
    <div className="flex flex-col gap-2" data-testid="person-status">
      {latest ? (
        <>
          <p className="text-muted-foreground text-[11.5px]">{t('followups_ps_latest', [dayShort(latest.at), from])}</p>
          <Lines label={t('followups_ps_did')} items={latest.did} testId="person-status-did" />
          <Lines label={t('followups_ps_doing')} items={latest.doing} testId="person-status-doing" />
          {latest.next.length > 0 && (
            <div data-testid="person-status-next">
              <Lines label={t('followups_ps_next')} items={latest.next} />
              {by && <p className="text-muted-foreground text-[11.5px]">{t('followups_ps_by', [by])}</p>}
            </div>
          )}
          <Lines label={t('followups_ps_blocked')} items={latest.blockers} />
        </>
      ) : (
        <p className="text-muted-foreground text-[12px]">{t('followups_ps_none')}</p>
      )}
      {tasks.length > 0 && (
        <div>
          <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
            {t('followups_ps_open')}
          </p>
          <ul className="list-disc pl-4 text-[12.5px] leading-snug">
            {tasks.map(task => (
              <li key={task.id}>
                {oneLine(task.title)}
                {task.due && <span className="text-muted-foreground"> · {isoDayShort(task.due)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {latest && offers.length > 0 && (
        <ul className="divide-border/60 flex flex-col divide-y">
          {offers.map(offer => (
            <MarkDoneLine key={offer.taskId} update={latest} offer={offer} />
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-1.5"
        onSubmit={event => {
          event.preventDefault();
          if (words.trim().length >= 2) void save();
        }}>
        <label className="text-muted-foreground text-[11.5px]" htmlFor={`report-${personId}`}>
          {t('followups_report_label', [name ?? ''])}
        </label>
        <div className="flex gap-1.5">
          <input
            id={`report-${personId}`}
            data-testid="person-report-input"
            value={words}
            maxLength={1000}
            onChange={event => setWords(event.target.value)}
            className="bg-secondary text-secondary-foreground min-w-0 flex-1 rounded-lg px-2 py-1 text-[12.5px]"
          />
          <Button size="sm" type="submit" data-testid="person-report-save" disabled={busy || words.trim().length < 2}>
            {t('followups_report_save')}
          </Button>
        </div>
        {saved && <p className="text-muted-foreground text-[11.5px]">{t('followups_report_saved')}</p>}
        {error && (
          <p role="alert" className="text-destructive text-[11.5px]">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
