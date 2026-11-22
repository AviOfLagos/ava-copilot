import { useState } from 'react';
import { ListTodo } from 'lucide-react';
import { t } from '@extension/i18n';
import { callPersonKey, db } from '@extension/storage';
import type { CallListRow, CallTaskSent, MeetingRecord, Person, Task } from '@extension/storage';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import { RecordButton, TaskRecordings } from '../recordings/TaskRecordings';
import type { TurnAddonProps } from '../registry';
import { callTasksRequest, TaskWords } from './shared';

/**
 * "Tasks from this call" under a meeting's note (docs/pm-desk.md, Part 6): the tasks Avi said on the call, by person,
 * each editable, each recording playable, and one button, "Looks right". Until that click nothing is sent and no
 * recording is shared. After it, each person has "Draft a message to Ada" (typed into WhatsApp Web, never sent).
 * Rows other parts add (`CallListRow`, e.g. "Mark done?" from the follow-ups part) show under their person.
 */

type MessageKey = Parameters<typeof t>[0];
const SENT_TEXT: Record<CallTaskSent['whatsapp'], MessageKey> = {
  sent: 'calltasks_sent_sent',
  queued: 'calltasks_sent_queued',
  off: 'calltasks_sent_off',
  empty: 'calltasks_sent_empty',
  done: 'calltasks_sent_done',
  failed: 'calltasks_sent_failed',
};

interface Group {
  key: string;
  name: string;
  tasks: Task[];
  rows: CallListRow[];
}

function groupsOf(tasks: Task[], rows: CallListRow[], people: Map<string, Person>): Group[] {
  const groups = new Map<string, Group>();
  const groupFor = (key: string, name: string) => {
    const group = groups.get(key) ?? { key, name, tasks: [], rows: [] };
    groups.set(key, group);
    return group;
  };
  for (const task of tasks) {
    const key = callPersonKey(task);
    const name = (task.ownerId && people.get(task.ownerId)?.name) || task.ownerName || t('calltasks_you');
    groupFor(key, name).tasks.push(task);
  }
  for (const row of rows) groupFor(row.personKey ?? 'me', row.personName || t('calltasks_you')).rows.push(row);
  return [...groups.values()];
}

function ExtraRow({ meetingId, row }: { meetingId: string; row: CallListRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <li className="flex flex-wrap items-center gap-1.5 text-[12px]" data-row-kind={row.kind}>
      <span>{row.text}</span>
      {row.action && (
        <Button
          size="sm"
          variant="glass"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError('');
            void callTasksRequest({ type: 'calltasks_row_action', meetingId, rowId: row.id })
              .catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
              .finally(() => setBusy(false));
          }}>
          {row.action.label}
        </Button>
      )}
      {error && <span className="text-destructive">{error}</span>}
    </li>
  );
}

function PersonGroup({
  meeting,
  group,
  sent,
  confirmed,
}: {
  meeting: MeetingRecord;
  group: Group;
  sent: CallTaskSent | undefined;
  confirmed: boolean;
}) {
  const [draft, setDraft] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const draftIt = async () => {
    setBusy(true);
    setDraft(null);
    try {
      await callTasksRequest({ type: 'calltasks_draft', meetingId: meeting.id, personKey: group.key });
      setDraft({ ok: true, text: t('calltasks_drafted', [group.name]) });
    } catch (failure) {
      setDraft({ ok: false, text: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-1.5" data-testid="calltasks-person" data-person={group.name}>
      <h3 className="text-[12.5px] font-semibold">{group.name}</h3>
      <ul className="flex flex-col gap-2 pl-1">
        {group.tasks.map(task => (
          <li key={task.id} className="flex flex-col gap-1" data-task-id={task.id}>
            <div className="flex items-start justify-between gap-1">
              <TaskWords task={task} withOwner locked={confirmed} />
              {!confirmed && <RecordButton task={task} />}
            </div>
            <TaskRecordings task={task} />
          </li>
        ))}
        {group.rows.map(row => (
          <ExtraRow key={row.id} meetingId={meeting.id} row={row} />
        ))}
      </ul>
      {confirmed && sent && (
        <p className="text-muted-foreground text-[11.5px]" data-testid="calltasks-sent">
          {t(SENT_TEXT[sent.whatsapp])}
        </p>
      )}
      {confirmed && group.key !== 'me' && group.tasks.length > 0 && (
        <div className="flex flex-col gap-1">
          <Button size="sm" variant="glass" className="self-start" disabled={busy} onClick={() => void draftIt()}>
            {t('calltasks_draft', [group.name])}
          </Button>
          {draft && (
            <p className={`text-[11.5px] ${draft.ok ? 'text-muted-foreground' : 'text-destructive'}`}>{draft.text}</p>
          )}
        </div>
      )}
    </li>
  );
}

/** Under a meeting's note in its chat, once the call is over. */
export function MeetingCallTasks({ thread, requestSeq }: TurnAddonProps) {
  const meetingId = thread.meetingId ?? null;
  const meeting = useLive(
    async () => (meetingId ? ((await db.meetings.get(meetingId)) ?? null) : null),
    [meetingId],
    null as MeetingRecord | null,
  );
  const state = meeting?.callTasks;
  const ids = (state?.tasks ?? []).map(entry => entry.taskId).join(',');
  const tasks = useLive(
    async () => (ids ? (await db.tasks.bulkGet([...new Set(ids.split(','))])).filter((x): x is Task => !!x) : []),
    [ids],
    [] as Task[],
  );
  const ownerIds = [...new Set(tasks.map(task => task.ownerId).filter((id): id is string => !!id))].join(',');
  const people = useLive(
    async () =>
      new Map(
        ownerIds
          ? (await db.people.bulkGet(ownerIds.split(','))).filter((p): p is Person => !!p).map(p => [p.id, p])
          : [],
      ),
    [ownerIds],
    new Map<string, Person>(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!meetingId || requestSeq !== null || !meeting || !state) return null;
  if (meeting.status === 'recording') return null;
  const kept = tasks.filter(task => task.status !== 'dropped');
  const rows = state.rows ?? [];
  if (!kept.length && !rows.length) return null;
  const confirmed = !!state.confirmedAt;
  const groups = groupsOf(kept, rows, people);

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await callTasksRequest({ type: 'calltasks_confirm', meetingId: meeting.id });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="glass flex flex-col gap-2 rounded-xl px-3 py-2.5"
      aria-label={t('calltasks_list_title')}
      data-testid="calltasks-list">
      <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
        <ListTodo className="size-3.5" aria-hidden />
        {t('calltasks_list_title')}
      </h2>
      <ul className="flex flex-col gap-3">
        {groups.map(group => (
          <PersonGroup
            key={group.key}
            meeting={meeting}
            group={group}
            confirmed={confirmed}
            sent={state.sent?.find(item => item.personKey === group.key)}
          />
        ))}
      </ul>
      {state.shareSkipped?.length ? (
        <p className="text-muted-foreground text-[11.5px]">
          {t('calltasks_shareSkipped', [state.shareSkipped.join(' ')])}
        </p>
      ) : null}
      {confirmed ? (
        <p className="text-muted-foreground text-[11.5px]" data-testid="calltasks-confirmed">
          {t('calltasks_confirmed')}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <Button size="sm" className="self-start" disabled={busy || !kept.length} onClick={() => void confirm()}>
            {t('calltasks_looksRight')}
          </Button>
          <p className="text-muted-foreground text-[11.5px]">{t('calltasks_looksRight_hint')}</p>
        </div>
      )}
      {error && <p className="text-destructive text-[11.5px]">{error}</p>}
    </section>
  );
}
