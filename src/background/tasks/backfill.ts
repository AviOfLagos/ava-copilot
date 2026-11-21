import { db as defaultDb, createTaskStore } from '@extension/storage';
import type { AviCopilotDb, MeetingRecord, TaskCandidate, TaskStore } from '@extension/storage';
import { GRAPH_TASK_SOURCES, graphCandidate, meetingCandidates } from './sources';

const DAY = 24 * 60 * 60 * 1000;
// How far back the one-time backfill reads
export const BACKFILL_DAYS = 30;
// Set once the backfill has run: it never runs twice
export const BACKFILL_KEY = 'tasks-backfill-v1';

type Pending =
  { candidate: TaskCandidate; meetingId: string; index: number } | { candidate: TaskCandidate; nodeId: string };

/**
 * Makes the board's first tasks from what the last 30 days said was to be done: meeting notes' action items and
 * the knowledge graph's actions, all open. Mentions are recorded oldest first, from both kinds of source together,
 * so the same task said in a meeting and read in a chat becomes one. Meeting items and graph nodes are given their
 * task's id. Running it again changes nothing. Returns how many tasks it made.
 */
export async function backfillTasks(
  db: AviCopilotDb = defaultDb,
  tasks: TaskStore = createTaskStore(db),
  now = Date.now(),
): Promise<number> {
  const since = now - BACKFILL_DAYS * DAY;
  const pending: Pending[] = [];

  const meetings = (await db.meetings.where('startedAt').aboveOrEqual(since).toArray()).filter(
    (meeting): meeting is MeetingRecord & { note: NonNullable<MeetingRecord['note']> } => !!meeting.note,
  );
  for (const meeting of meetings) {
    meetingCandidates(meeting, meeting.note).forEach((candidate, index) => {
      if (!meeting.note.actionItems[index].taskId) pending.push({ candidate, meetingId: meeting.id, index });
    });
  }

  const actions = (await db.graphNodes.where('type').equals('action').toArray()).filter(
    node => node.date >= since && !node.taskId,
  );
  for (const node of actions) {
    const item = await db.kbItems.get(node.sourceItemIds[0] ?? '');
    if (!item || !GRAPH_TASK_SOURCES.has(item.sourceType)) continue;
    const edge = (await db.graphEdges.where('from').equals(node.id).toArray()).find(
      candidate => candidate.kind === 'assigned_to',
    );
    const owner = edge ? ((await db.graphNodes.get(edge.to))?.label ?? null) : null;
    pending.push({ candidate: graphCandidate(item, node, owner), nodeId: node.id });
  }

  pending.sort((a, b) => (a.candidate.at ?? 0) - (b.candidate.at ?? 0));
  const before = await db.tasks.count();
  const meetingIds = new Map<string, Map<number, string>>();
  for (const entry of pending) {
    const recorded = await tasks.record(entry.candidate);
    if (!recorded) continue;
    if ('nodeId' in entry) {
      await db.graphNodes.update(entry.nodeId, { taskId: recorded.task.id });
    } else {
      if (!meetingIds.has(entry.meetingId)) meetingIds.set(entry.meetingId, new Map());
      meetingIds.get(entry.meetingId)!.set(entry.index, recorded.task.id);
    }
  }
  for (const [meetingId, ids] of meetingIds) {
    await db.transaction('rw', db.meetings, async () => {
      const meeting = await db.meetings.get(meetingId);
      if (!meeting?.note) return;
      const actionItems = meeting.note.actionItems.map((item, index) =>
        ids.has(index) ? { ...item, taskId: ids.get(index) } : item,
      );
      await db.meetings.update(meetingId, { note: { ...meeting.note, actionItems } });
    });
  }
  return (await db.tasks.count()) - before;
}

/** Runs the backfill unless it already ran. The flag is set only after it finished. */
export async function backfillOnce(
  run: () => Promise<number> = () => backfillTasks(),
  flags: Pick<chrome.storage.StorageArea, 'get' | 'set'> = chrome.storage.local,
): Promise<boolean> {
  const stored = await flags.get(BACKFILL_KEY);
  if (stored[BACKFILL_KEY]) return false;
  await run();
  await flags.set({ [BACKFILL_KEY]: Date.now() });
  return true;
}
