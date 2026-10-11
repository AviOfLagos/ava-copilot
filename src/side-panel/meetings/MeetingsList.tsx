import { Disc } from 'lucide-react';
import { t } from '@extension/i18n';
import { meetingStore } from '@extension/storage';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';

interface MeetingsListProps {
  onOpen: (meetingId: string) => void;
  onTakeNotes: () => void;
  recordingId: string | null;
}

function minutes(start: number, end: number | null): string {
  return end ? `${Math.max(1, Math.round((end - start) / 60_000))} min` : '';
}

/** Every meeting with notes, newest first, and the button that starts notes on the call in front. */
export default function MeetingsList({ onOpen, onTakeNotes, recordingId }: MeetingsListProps) {
  const meetings = useLive(() => meetingStore.list(), [], []);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
      <Button variant="glass" size="lg" onClick={onTakeNotes} className="justify-start gap-2">
        <Disc className="size-4" />
        {recordingId ? t('meeting_openNotes') : t('meeting_take')}
      </Button>
      {meetings.length === 0 && <p className="text-muted-foreground px-1 text-[12.5px]">{t('meetings_empty')}</p>}
      <ul className="flex flex-col gap-1">
        {meetings.map(meeting => (
          <li key={meeting.id}>
            <button
              type="button"
              onClick={() => onOpen(meeting.id)}
              className="hover:bg-accent flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left">
              {meeting.status === 'recording' && (
                <span className="bg-destructive size-2 shrink-0 animate-pulse rounded-full" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">
                  {meeting.note?.title || meeting.topic || meeting.title || t('threads_untitled')}
                </span>
                <span className="text-muted-foreground text-[11.5px]">
                  {new Date(meeting.startedAt).toLocaleString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                  {meeting.endedAt ? ` · ${minutes(meeting.startedAt, meeting.endedAt)}` : ''}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
