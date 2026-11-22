import { useState } from 'react';
import { Captions, ListTodo, Mic, MicOff } from 'lucide-react';
import { t } from '@extension/i18n';
import { db } from '@extension/storage';
import type { CallCommandOffReason, CallTaskEntry, MeetingRecord, Task } from '@extension/storage';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import { recordTask as startScreenRecording } from '../recordings/TaskRecordings';
import { useRecorder } from '../recordings/useRecorder';
import { callTasksRequest, TaskWords } from './shared';

/**
 * During a call (docs/pm-desk.md, Part 6): one quiet line saying whether "Ava, note a task for…" is heard and how,
 * and a small card for each task just said, with Edit, Discard and "Record the screen for this?". No sound plays in
 * the call. With the panel closed none of this shows; the tasks are stored all the same, and the recording is
 * offered on the after-call list.
 */

// The newest tasks get a card; the rest are on the after-call list
const CARDS = 3;

type MessageKey = Parameters<typeof t>[0];
const OFF_TEXT: Record<CallCommandOffReason, MessageKey> = {
  no_captions_no_mic: 'calltasks_status_off_none',
  no_local_recogniser: 'calltasks_status_off_recogniser',
  mic_denied: 'calltasks_status_off_micDenied',
  mic_off: 'calltasks_status_off_mic',
  no_self_marker: 'calltasks_status_off_marker',
};

function StatusLine({ meeting }: { meeting: MeetingRecord }) {
  const state = meeting.callTasks;
  if (!state) return null;
  const on = state.signal !== 'off';
  const Icon = state.signal === 'captions' ? Captions : state.signal === 'mic' ? Mic : MicOff;
  const text = on
    ? t(state.signal === 'captions' ? 'calltasks_status_captions' : 'calltasks_status_mic')
    : t(OFF_TEXT[state.offReason ?? 'no_captions_no_mic']);
  return (
    <p
      className="text-muted-foreground flex items-start gap-1.5 text-[11.5px] leading-snug"
      data-testid="calltasks-status"
      data-signal={state.signal}>
      <Icon className={`mt-px size-3.5 shrink-0 ${on ? 'text-primary' : ''}`} aria-hidden />
      <span>{text}</span>
    </p>
  );
}

function TaskCard({ meetingId, entry, task }: { meetingId: string; entry: CallTaskEntry; task: Task }) {
  const recorder = useRecorder();
  const [answered, setAnswered] = useState(entry.recordOffer ?? null);
  const who = task.ownerName ?? entry.ownerName;
  const answer = (value: 'yes' | 'no') => {
    // The click itself starts the recording (the picker needs it); only then is the answer told
    if (value === 'yes' && !startScreenRecording(task)) return;
    setAnswered(value);
    void callTasksRequest({ type: 'calltasks_record_answer', meetingId, taskId: task.id, answer: value }).catch(
      () => {},
    );
  };
  return (
    <section
      className="glass flex flex-col gap-1.5 rounded-xl px-3 py-2"
      aria-label={who ? t('calltasks_card_title', [who]) : t('calltasks_card_forYou')}
      data-testid="calltask-card"
      data-task-id={task.id}>
      <h3 className="flex items-center gap-1.5 text-[12px] font-semibold">
        <ListTodo className="size-3.5" aria-hidden />
        {who ? t('calltasks_card_title', [who]) : t('calltasks_card_forYou')}
      </h3>
      <TaskWords task={task} />
      {!answered && recorder.phase === 'idle' && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="text-muted-foreground">{t('calltasks_record_ask')}</span>
          <Button size="sm" variant="glass" onClick={() => answer('yes')}>
            {t('calltasks_yes')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => answer('no')}>
            {t('calltasks_no')}
          </Button>
        </div>
      )}
    </section>
  );
}

export function CallTaskCards() {
  const meeting = useLive(
    async () => (await db.meetings.where('status').equals('recording').toArray())[0] ?? null,
    [],
    null as MeetingRecord | null,
  );
  const entries = meeting?.callTasks?.tasks ?? [];
  const ids = entries.map(entry => entry.taskId).join(',');
  const tasks = useLive(
    async () => (ids ? (await db.tasks.bulkGet(ids.split(','))).filter((task): task is Task => !!task) : []),
    [ids],
    [] as Task[],
  );
  if (!meeting?.callTasks) return null;
  const byId = new Map(tasks.map(task => [task.id, task]));
  const shown = [...entries]
    .reverse()
    .filter(entry => byId.get(entry.taskId)?.status === 'open')
    .filter((entry, index, all) => all.findIndex(other => other.taskId === entry.taskId) === index)
    .slice(0, CARDS);
  return (
    <div className="flex flex-col gap-1.5 px-2.5 pt-2" data-testid="calltasks-live">
      <StatusLine meeting={meeting} />
      {shown.map(entry => (
        <TaskCard key={entry.taskId} meetingId={meeting.id} entry={entry} task={byId.get(entry.taskId)!} />
      ))}
    </div>
  );
}
