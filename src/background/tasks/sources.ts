import { recordTask } from '@extension/storage';
import type {
  GraphNode,
  GraphSlice,
  KnowledgeItem,
  MeetingNote,
  MeetingRecord,
  TaskCandidate,
  TaskSourceKind,
} from '@extension/storage';

// Every source that names something to do reaches the board through recordTask (docs/pm-desk.md, Part 2.2):
// meeting notes' action items and the knowledge graph's action readings. Plain code, no model.

export type RecordFn = (candidate: TaskCandidate) => Promise<{ task: { id: string } } | null>;

/** What kind of source a knowledge item is, as the board names it. */
export function sourceKindOf(item: Pick<KnowledgeItem, 'sourceType'>): TaskSourceKind {
  switch (item.sourceType) {
    case 'meeting':
      return 'meeting';
    case 'thread':
      return 'chat';
    default:
      return 'note';
  }
}

/** A meeting note's action items as mentions, with the due words kept and read from the meeting's day. */
export function meetingCandidates(
  meeting: Pick<MeetingRecord, 'id' | 'startedAt' | 'workspaceId'>,
  note: Pick<MeetingNote, 'actionItems'>,
): TaskCandidate[] {
  return note.actionItems.map(item => ({
    title: item.task,
    ownerName: item.owner,
    dueText: item.due,
    workspaceId: meeting.workspaceId ?? null,
    source: { kind: 'meeting', id: meeting.id },
    at: meeting.startedAt,
  }));
}

/**
 * Records a meeting note's action items and returns the note with each item's task id. An item that could not
 * be recorded keeps no id; the note is still saved.
 */
export async function withMeetingTasks<N extends Pick<MeetingNote, 'actionItems'>>(
  meeting: Pick<MeetingRecord, 'id' | 'startedAt' | 'workspaceId'>,
  note: N,
  record: RecordFn = recordTask,
): Promise<N> {
  const candidates = meetingCandidates(meeting, note);
  const actionItems = [];
  for (const [index, item] of note.actionItems.entries()) {
    const recorded = await record(candidates[index]).catch(() => null);
    // Only this code gives an item its task id: one that came in with the model's words is dropped
    const own = { owner: item.owner, task: item.task, due: item.due };
    actionItems.push(recorded ? { ...own, taskId: recorded.task.id } : own);
  }
  return { ...note, actionItems };
}

/** The owner an action is assigned to in a slice: the label of the person its "assigned_to" edge points at. */
function ownerIn(slice: Pick<GraphSlice, 'entities' | 'edges'>, actionId: string): string | null {
  const edge = slice.edges.find(item => item.from === actionId && item.kind === 'assigned_to');
  return (edge && slice.entities.find(entity => entity.id === edge.to)?.label) || null;
}

/** A graph action as a mention, from the knowledge item that raised it. */
export function graphCandidate(
  item: Pick<KnowledgeItem, 'sourceType' | 'sourceId' | 'workspaceId' | 'sourceDate'>,
  action: Pick<GraphNode, 'label' | 'workspaceId' | 'date'>,
  owner: string | null,
): TaskCandidate {
  return {
    title: action.label,
    ownerName: owner,
    workspaceId: action.workspaceId ?? item.workspaceId ?? null,
    // A meeting's id, a chat's id, a note's or page's own id: the same id a meeting note's items carry
    source: { kind: sourceKindOf(item), id: item.sourceId },
    at: item.sourceDate || action.date,
  };
}

/**
 * Records a slice's actions and returns the slice with each action node carrying its task id. The graph keeps its
 * action nodes, for the graph view; the board is where they are ticked.
 */
export async function withGraphTasks(
  item: Pick<KnowledgeItem, 'sourceType' | 'sourceId' | 'workspaceId' | 'sourceDate'>,
  slice: GraphSlice,
  record: RecordFn = recordTask,
): Promise<GraphSlice> {
  const entities: GraphNode[] = [];
  for (const entity of slice.entities) {
    if (entity.type !== 'action') {
      entities.push(entity);
      continue;
    }
    const recorded = await record(graphCandidate(item, entity, ownerIn(slice, entity.id))).catch(() => null);
    entities.push(recorded ? { ...entity, taskId: recorded.task.id } : entity);
  }
  return { ...slice, entities };
}
