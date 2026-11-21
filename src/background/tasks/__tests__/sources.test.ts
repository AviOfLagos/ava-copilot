import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb, createTaskStore } from '@extension/storage';
import type { GraphNode, KnowledgeItem, MeetingNote, MeetingRecord, TaskStore } from '@extension/storage';
import { backfillOnce, backfillTasks } from '../backfill';
import { withGraphTasks, withMeetingTasks } from '../sources';

const DAY = 24 * 60 * 60 * 1000;
// Wednesday 18 November 2026, 10:00 local
const NOW = new Date(2026, 10, 18, 10).getTime();

let db: AviCopilotDb;
let tasks: TaskStore;

beforeEach(() => {
  db = new AviCopilotDb(`task-sources-${crypto.randomUUID()}`);
  tasks = createTaskStore(db, { now: () => NOW });
});

const note = (actionItems: MeetingNote['actionItems']): MeetingNote => ({
  title: 'Weekly sync',
  tldr: [],
  decisions: [],
  actionItems,
  openQuestions: [],
  participants: [],
});

const meeting = (id: string, startedAt: number, items: MeetingNote['actionItems']): MeetingRecord =>
  ({
    id,
    threadId: null,
    startedAt,
    endedAt: startedAt + 3_600_000,
    status: 'done',
    title: 'Weekly sync',
    platform: 'meet',
    workspaceId: 'ws-1',
    note: note(items),
  }) as unknown as MeetingRecord;

const item = (id: string, sourceType: KnowledgeItem['sourceType'], sourceId: string, sourceDate: number) =>
  ({
    id,
    sourceType,
    sourceId,
    title: 'Source',
    sourceDate,
    sourceUpdatedAt: sourceDate,
    createdAt: sourceDate,
    updatedAt: sourceDate,
    chunkCount: 0,
    unembedded: 0,
    workspaceId: 'ws-1',
  }) as KnowledgeItem;

const action = (id: string, label: string, date: number, sourceItemId: string): GraphNode => ({
  id,
  type: 'action',
  label,
  workspaceId: 'ws-1',
  sourceItemIds: [sourceItemId],
  date,
  updatedAt: date,
});

describe('meeting notes on the board', () => {
  it('records each action item, keeps "by Friday" as a date, and gives the item its task id', async () => {
    const said = new Date(2026, 10, 16, 9).getTime(); // a Monday
    const written = await withMeetingTasks(
      meeting('m-1', said, []),
      note([
        { owner: 'Ada', task: 'Send the login', due: 'by Friday' },
        { owner: 'Unassigned', task: 'Book the room', due: null },
      ]),
      candidate => tasks.record(candidate),
    );
    expect(written.actionItems.every(entry => entry.taskId?.startsWith('tsk_'))).toBe(true);
    const login = await tasks.get(written.actionItems[0].taskId!);
    expect(login).toMatchObject({ title: 'Send the login', ownerName: 'Ada', due: '2026-11-20', dueText: 'by Friday' });
    expect(login?.source).toEqual({ kind: 'meeting', id: 'm-1' });
    expect((await tasks.get(written.actionItems[1].taskId!))?.ownerName).toBeNull();
  });

  it('makes the same task said in two meetings one task', async () => {
    const first = await withMeetingTasks(
      meeting('m-1', NOW - 7 * DAY, []),
      note([{ owner: 'Ada', task: 'Send the login', due: null }]),
      candidate => tasks.record(candidate),
    );
    const second = await withMeetingTasks(
      meeting('m-2', NOW, []),
      note([{ owner: 'Ada', task: 'send the login.', due: 'tomorrow' }]),
      candidate => tasks.record(candidate),
    );
    expect(second.actionItems[0].taskId).toBe(first.actionItems[0].taskId);
    const all = await tasks.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ seenIn: ['m-1', 'm-2'], due: '2026-11-19' });
  });

  it('still saves the note when the board cannot be written', async () => {
    const written = await withMeetingTasks(
      meeting('m-1', NOW, []),
      note([{ owner: 'Ada', task: 'Send the login', due: null }]),
      async () => {
        throw new Error('down');
      },
    );
    expect(written.actionItems[0].taskId).toBeUndefined();
  });
});

describe('graph actions on the board', () => {
  it('records each action with its owner and gives its node the task id', async () => {
    const source = item('thread:c-1', 'thread', 'c-1', NOW);
    const slice = await withGraphTasks(
      source,
      {
        source: { ...action('thread:c-1', 'Chat', NOW, 'thread:c-1'), type: 'thread' },
        entities: [
          action('action:1', 'Draft the pricing page', NOW, 'thread:c-1'),
          { ...action('person:ws-1:bo', 'Bo', NOW, 'thread:c-1'), type: 'person' },
        ],
        edges: [{ from: 'action:1', to: 'person:ws-1:bo', kind: 'assigned_to' }],
      },
      candidate => tasks.record(candidate),
    );
    const node = slice.entities.find(entity => entity.id === 'action:1');
    const task = await tasks.get(node!.taskId!);
    expect(task).toMatchObject({
      title: 'Draft the pricing page',
      ownerName: 'Bo',
      source: { kind: 'chat', id: 'c-1' },
    });
    expect(slice.entities.find(entity => entity.type === 'person')?.taskId).toBeUndefined();
  });
});

describe('the one-time backfill', () => {
  async function seed() {
    // A meeting 20 days ago and one 3 days ago name the same task; one 40 days ago is too old
    await db.meetings.bulkAdd([
      meeting('m-old', NOW - 40 * DAY, [{ owner: 'Ada', task: 'Renew the domain', due: null }]),
      meeting('m-a', NOW - 10 * DAY, [{ owner: 'Ada', task: 'Send the login', due: 'by Friday' }]),
      meeting('m-b', NOW - 3 * DAY, [{ owner: 'Ada', task: 'Send the login', due: null }]),
    ]);
    // The graph read the second meeting too, and a chat named a task of its own
    await db.kbItems.bulkAdd([
      item('meeting:m-b', 'meeting', 'm-b', NOW - 3 * DAY),
      item('thread:c-1', 'thread', 'c-1', NOW - 2 * DAY),
    ]);
    await db.graphNodes.bulkAdd([
      action('action:m-b', 'Send the login', NOW - 3 * DAY, 'meeting:m-b'),
      action('action:c-1', 'Draft the pricing page', NOW - 2 * DAY, 'thread:c-1'),
      action('action:old', 'Very old thing', NOW - 45 * DAY, 'thread:c-1'),
    ]);
  }

  it('makes tasks from the last 30 days, all open, each said once', async () => {
    await seed();
    expect(await backfillTasks(db, tasks, NOW)).toBe(2);
    const all = await tasks.list();
    expect(all.map(task => task.title).sort()).toEqual(['Draft the pricing page', 'Send the login']);
    expect(all.every(task => task.status === 'open')).toBe(true);
    const login = all.find(task => task.title === 'Send the login')!;
    // Said on Sunday 8 November "by Friday": Friday 13 November, kept through the merge
    expect(login.due).toBe('2026-11-13');
    expect(login.seenIn).toEqual(['m-a', 'm-b']);
    expect(login.createdAt).toBe(NOW - 10 * DAY);
  });

  it('gives meeting items and graph nodes their task ids', async () => {
    await seed();
    await backfillTasks(db, tasks, NOW);
    const login = (await tasks.list()).find(task => task.title === 'Send the login')!;
    expect((await db.meetings.get('m-a'))?.note?.actionItems[0].taskId).toBe(login.id);
    expect((await db.meetings.get('m-b'))?.note?.actionItems[0].taskId).toBe(login.id);
    expect((await db.graphNodes.get('action:m-b'))?.taskId).toBe(login.id);
    expect((await db.meetings.get('m-old'))?.note?.actionItems[0].taskId).toBeUndefined();
    expect((await db.graphNodes.get('action:old'))?.taskId).toBeUndefined();
  });

  it('changes nothing when run again', async () => {
    await seed();
    await backfillTasks(db, tasks, NOW);
    const before = await tasks.list();
    expect(await backfillTasks(db, tasks, NOW)).toBe(0);
    expect(await tasks.list()).toEqual(before);
  });

  it('runs once, and the flag is set only after it finished', async () => {
    const stored: Record<string, unknown> = {};
    const flags = {
      get: async (key: string) => (key in stored ? { [key]: stored[key] } : {}),
      set: async (values: Record<string, unknown>) => void Object.assign(stored, values),
    } as unknown as Pick<chrome.storage.StorageArea, 'get' | 'set'>;
    let runs = 0;
    await expect(
      backfillOnce(async () => {
        throw new Error('down');
      }, flags),
    ).rejects.toThrow('down');
    expect(await backfillOnce(async () => ++runs, flags)).toBe(true);
    expect(await backfillOnce(async () => ++runs, flags)).toBe(false);
    expect(runs).toBe(1);
  });
});
