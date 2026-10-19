import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { t } from '@extension/i18n';
import { meetingStore, upcomingEventsStore } from '@extension/storage';
import type { MeetingRecord, UpcomingEvent } from '@extension/storage';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import type { PanelApi } from '../registry';
import { captureOf } from './status';

interface AutoNotesCardProps {
  // The meeting being recorded, if any
  recording: MeetingRecord | undefined;
  api: Pick<PanelApi, 'request' | 'post'>;
  onOpen: (meetingId: string) => void;
  // The meeting open in the panel right now, whose own view already offers Retry
  viewing?: string | null;
}

// A note that failed to be written is offered again for a day
const FAILED_FOR_MS = 24 * 3_600_000;

const DISMISSED_KEY = 'auto-notes-dismissed';

function dismissed(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/**
 * Notes that started on their own when the user joined a call. Nothing here blocks them: the card
 * says they are running, offers an optional note on what the call is about (context for the summary
 * and the notes), and, when only captions are being read, how to record the audio. It shows at the top
 * of the panel wherever the user is, and goes away when dismissed.
 */
export default function AutoNotesCard({ recording, api, onOpen, viewing = null }: AutoNotesCardProps) {
  const [hidden, setHidden] = useState<string[]>(dismissed);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const meetingId = recording?.auto ? recording.id : null;
  const words = useLive(
    () => (meetingId ? meetingStore.segments(meetingId).then(lines => lines.length) : Promise.resolve(0)),
    [meetingId],
    0,
  );
  // The latest meeting whose note could not be written, so Retry is never more than a glance away
  const failed = useLive(
    async () =>
      (await meetingStore.db.meetings.where('status').equals('failed').toArray())
        .filter(meeting => (meeting.endedAt ?? meeting.startedAt) > Date.now() - FAILED_FOR_MS)
        .sort((a, b) => b.startedAt - a.startedAt)[0],
    [],
    undefined,
  );

  useEffect(() => {
    setNote('');
    setError(null);
    if (!meetingId) return;
    void (async () => {
      const { events } = await upcomingEventsStore.get();
      const now = Date.now();
      const today = (events ?? []).filter((event: UpcomingEvent) => event.end > now - 3_600_000).slice(0, 3);
      const recent = (await meetingStore.list()).filter(meeting => meeting.topic && meeting.id !== meetingId);
      const names = [...today.map(event => event.title), ...recent.map(meeting => meeting.topic ?? '')];
      setSuggestions([...new Set(names.filter(Boolean))].slice(0, 3));
    })().catch(() => {});
  }, [meetingId]);

  const dismiss = (id: string) => {
    const next = [...hidden, id];
    setHidden(next);
    try {
      sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next.slice(-20)));
    } catch {
      // Hidden for this view only
    }
  };

  const run = async (message: Record<string, unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await api.request({ ...message, meetingId });
      after?.();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };
  if (!recording || !meetingId || hidden.includes(meetingId)) {
    // No call running: a meeting whose note failed still offers Retry here, until it works or is dismissed
    if (!failed || hidden.includes(failed.id) || failed.id === viewing) return null;
    return (
      <section
        aria-labelledby="notes-failed-title"
        className="glass mx-2.5 mt-2 rounded-2xl border border-destructive/30 p-3 text-[12.5px]">
        <div className="flex items-center gap-2">
          <h2 id="notes-failed-title" className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {t('meeting_alert_noteFailedTitle')}
          </h2>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('meeting_auto_dismiss')}
            onClick={() => dismiss(failed.id)}>
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
        <p role="alert" className="mt-2 text-muted-foreground">
          {failed.title} · {t('meeting_warning_noteFailed')}
        </p>
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => onOpen(failed.id)}>
            {t('meeting_auto_open')}
          </Button>
          <Button size="sm" onClick={() => api.post({ type: 'meeting_retry', meetingId: failed.id })}>
            {t('meeting_retry')}
          </Button>
        </div>
      </section>
    );
  }
  const askNote = !recording.topic && saved !== meetingId;
  const captionsOnly = recording.source === 'captions';
  const nothing = recording.warnings.includes('nothing_captured');
  const capture = captureOf(recording, words);
  if (!askNote && !captionsOnly && !nothing && capture === 'hearing' && saved !== meetingId) return null;

  const addNote = (text: string) => {
    if (text.trim()) void run({ type: 'meeting_add_note', note: text }, () => setSaved(meetingId));
  };
  // Only "Taking notes" once words come in; before that the card says what it waits for
  const title =
    capture === 'hearing'
      ? t('meeting_auto_notifyTitle')
      : capture === 'captions_off'
        ? t('meeting_auto_waitingTitle')
        : t('meeting_auto_waitingWords');
  const hint = nothing
    ? null
    : capture === 'captions_off'
      ? t('meeting_warning_captionsOff')
      : capture === 'waiting_captions'
        ? t('meeting_auto_waitingCaptionsBody')
        : captionsOnly
          ? t('meeting_auto_captionsOnly')
          : null;
  const recordAudio = (
    <Button size="sm" variant="glass" disabled={busy} onClick={() => void run({ type: 'meeting_add_audio' })}>
      {t('meeting_auto_recordAudio')}
    </Button>
  );

  return (
    <section
      aria-labelledby="auto-notes-title"
      className="glass mx-2.5 mt-2 rounded-2xl border border-destructive/30 p-3 text-[12.5px]">
      <div className="flex items-center gap-2">
        <span
          className={`size-2 shrink-0 rounded-full ${capture === 'hearing' ? 'animate-pulse bg-destructive' : 'bg-muted-foreground'}`}
          aria-hidden
        />
        <h2 id="auto-notes-title" className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {title}
          {recording.platform && <span className="font-normal text-muted-foreground"> · {recording.platform}</span>}
        </h2>
        <Button size="sm" variant="ghost" onClick={() => onOpen(meetingId)}>
          {t('meeting_auto_open')}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('meeting_auto_dismiss')}
          onClick={() => dismiss(meetingId)}>
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>

      {nothing && (
        <p role="alert" className="mt-2 rounded-xl border border-destructive/50 bg-destructive/15 px-2.5 py-1.5">
          {t('meeting_warning_nothingCaptured')}
        </p>
      )}
      {hint && (
        <div className="mt-2 flex items-center gap-2">
          <p
            role={capture === 'captions_off' ? 'alert' : undefined}
            className={`min-w-0 flex-1 ${capture === 'captions_off' ? 'text-foreground' : 'text-muted-foreground'}`}>
            {hint}
          </p>
          {captionsOnly && recordAudio}
        </div>
      )}
      {!hint && captionsOnly && <div className="mt-2 flex justify-end">{recordAudio}</div>}

      {saved === meetingId && (
        <p role="status" className="mt-2 text-muted-foreground">
          {t('meeting_auto_noteSaved')}
        </p>
      )}
      {askNote && (
        <>
          <p className="mt-2 text-muted-foreground">{t('meeting_auto_cardAsk')}</p>
          {suggestions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {suggestions.map(suggestion => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={busy}
                  onClick={() => addNote(suggestion)}
                  className="glass max-w-full truncate rounded-full px-2.5 py-0.5 text-[12px] hover:bg-accent">
                  {suggestion}
                </button>
              ))}
            </div>
          )}
          <form
            className="mt-2 flex gap-2"
            onSubmit={event => {
              event.preventDefault();
              addNote(note);
            }}>
            <label htmlFor="auto-notes-note" className="sr-only">
              {t('meeting_auto_noteLabel')}
            </label>
            <input
              id="auto-notes-note"
              value={note}
              maxLength={2000}
              onChange={event => setNote(event.target.value)}
              placeholder={t('meeting_auto_placeholder')}
              className="glass min-w-0 flex-1 rounded-xl px-3 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
            />
            <Button type="submit" size="sm" disabled={busy || !note.trim()}>
              {t('meeting_auto_save')}
            </Button>
          </form>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run({ type: 'meeting_skip_call' })}
            className="mt-2 text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {t('meeting_auto_skip')}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
