import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AviCopilotDb, createTaskStore, kbItemId, newMeeting, newThread } from '@extension/storage';
import type { KnowledgeItem, WorkspaceSetBy } from '@extension/storage';
import { createItemSource } from '../items';
import type { ItemSource } from '../items';
import { acceptOffer, makeOffer, makeWorkspace, moveItems, undoMove, INBOX_UNDO_MS } from '../place';
import { createPlacementStore, emptyPlacementState } from '@extension/storage';
import type { PlaceDeps } from '../place';
import { ORCHID } from './fixtures';

// The real item source over a real (in-memory) database: how each kind is read and moved, and that an undo puts back
// exactly what was there

let db: AviCopilotDb;
let source: ItemSource;
const kbCalls: { ids: string[]; workspaceId: string | null; setBy: WorkspaceSetBy | null }[] = [];

const kbItem = (
  id: string,
  sourceType: KnowledgeItem['sourceType'],
  fields: Partial<KnowledgeItem> = {},
): KnowledgeItem =>
  ({
    id,
    sourceType,
    sourceId: id.split(':')[1] ?? id,
    title: 'Saved thing',
    url: '',
    sourceDate: 0,
    sourceUpdatedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    chunkCount: 0,
    unembedded: 0,
    workspaceId: null,
    ...fields,
  }) as KnowledgeItem;

beforeEach(() => {
  db = new AviCopilotDb(`items-${crypto.randomUUID()}`);
  kbCalls.length = 0;
  source = createItemSource({
    db,
    kbSetWorkspace: vi.fn(async (ids, workspaceId, setBy, unchanged) => {
      kbCalls.push({ ids, workspaceId, setBy });
      let moved = 0;
      for (const id of ids) {
        const record = await db.kbItems.get(id);
        if (
          unchanged &&
          ((record?.workspaceId ?? null) !== unchanged.workspaceId ||
            (record?.workspaceSetBy ?? null) !== unchanged.setBy)
        ) {
          continue;
        }
        await db.kbItems.update(id, { workspaceId, workspaceSetBy: setBy ?? undefined });
        moved++;
      }
      return moved;
    }),
  });
});

describe('listing', () => {
  it('lists open tasks, loose chats, finished meetings and standalone knowledge, with who placed each', async () => {
    const tasks = createTaskStore(db);
    await tasks.record({
      title: 'Send the Orchid quote',
      ownerName: 'Ada Obi',
      workspaceId: null,
      source: { kind: 'chat' },
    });
    const done = await tasks.record({ title: 'Already finished', workspaceId: null, source: { kind: 'chat' } });
    await tasks.setStatus(done!.task.id, 'done', 'avi');
    await db.threads.add(
      newThread({ id: 'chat-1', title: 'Pricing chat', workspaceId: 'orchid', workspaceSetBy: 'avi' }),
    );
    await db.messages.add({
      id: 'u1',
      threadId: 'chat-1',
      seq: 1,
      actor: 'user',
      content: 'What does Orchid charge?',
      ts: 1,
      error: null,
    } as never);
    await db.threads.add(newThread({ id: 'chat-brief', title: 'Brief', tags: ['brief'] }));
    await db.threads.add(newThread({ id: 'chat-archived', title: 'Old', archived: true }));
    await db.threads.add(newThread({ id: 'chat-notes', title: 'Notes', meetingId: 'meet-1' }));
    await db.meetings.add(
      newMeeting({
        id: 'meet-1',
        status: 'done',
        topic: 'Orchid sync',
        topicSource: 'user',
        title: 'Invite title',
        roster: ['Ada Obi'],
      }),
    );
    await db.meetings.add(newMeeting({ id: 'meet-2', status: 'recording' }));
    await db.kbItems.bulkAdd([
      kbItem('page:p1', 'page', { title: 'Orchid is the best', url: 'https://example.com/pricing' }),
      kbItem('note:n1', 'note', { title: 'My note about Harbor', workspaceId: 'harbor', workspaceSetBy: 'avi' }),
      kbItem('thread:chat-1', 'thread'),
      kbItem('meeting:meet-1', 'meeting'),
    ]);

    const list = await source.list();
    const byRef = Object.fromEntries(list.map(one => [`${one.ref.kind}:${one.ref.id}`, one]));
    expect(Object.keys(byRef).filter(key => !key.startsWith('task:'))).toEqual([
      'thread:chat-1',
      'meeting:meet-1',
      'kb:note:n1',
      'kb:page:p1',
    ]);
    expect(list.filter(one => one.ref.kind === 'task')).toHaveLength(1);
    expect(list.find(one => one.ref.kind === 'task')).toMatchObject({ names: ['Ada Obi'], setBy: 'rule' });
    expect(byRef['thread:chat-1']).toMatchObject({ workspaceId: 'orchid', setBy: 'avi' });
    expect(byRef['thread:chat-1'].text).toContain('What does Orchid charge?');
    // A meeting's words are what Avi typed, never the invite's title; its names are the roster
    expect(byRef['meeting:meet-1']).toMatchObject({ text: 'Orchid sync', names: ['Ada Obi'], setBy: null });
    // A page says what it likes in its title: only its address is read
    expect(byRef['kb:page:p1'].text).toBe('https://example.com/pricing');
    expect(byRef['kb:note:n1'].text).toContain('Harbor');
  });

  it('reads a meeting whose topic came from an invite as having no words', async () => {
    await db.meetings.add(
      newMeeting({ id: 'meet-3', status: 'done', topic: 'Wire money now', topicSource: 'calendar' }),
    );
    const found = await source.get({ kind: 'meeting', id: 'meet-3' });
    expect(found?.text).toBe('');
  });
});

describe('moving', () => {
  it('moves a task without touching its date, and a chat with the knowledge that follows it', async () => {
    const tasks = createTaskStore(db);
    const { task } = (await tasks.record({ title: 'Do it', workspaceId: null, source: { kind: 'chat' }, at: 5 }))!;
    const before = (await db.tasks.get(task.id))!.updatedAt;
    await db.threads.add(newThread({ id: 'chat-1' }));
    await db.kbItems.add(kbItem(kbItemId('thread', 'chat-1'), 'thread'));

    await source.set({ kind: 'task', id: task.id }, 'orchid', 'rule');
    await source.set({ kind: 'thread', id: 'chat-1' }, 'orchid', 'avi');
    expect(await db.tasks.get(task.id)).toMatchObject({
      workspaceId: 'orchid',
      workspaceSetBy: 'rule',
      updatedAt: before,
    });
    expect(await db.threads.get('chat-1')).toMatchObject({ workspaceId: 'orchid', workspaceSetBy: 'avi' });
    // What follows a chat has no placement of its own
    expect(kbCalls).toEqual([{ ids: ['thread:chat-1'], workspaceId: 'orchid', setBy: null }]);
    expect((await db.kbItems.get('thread:chat-1'))?.workspaceId).toBe('orchid');
  });

  it('moves a meeting with its notes chat and its knowledge', async () => {
    await db.threads.add(newThread({ id: 'notes', meetingId: 'meet-1' }));
    await db.meetings.add(newMeeting({ id: 'meet-1', status: 'done', threadId: 'notes' }));
    await db.kbItems.add(kbItem('meeting:meet-1', 'meeting'));
    await source.set({ kind: 'meeting', id: 'meet-1' }, 'harbor', 'rule');
    expect(await db.meetings.get('meet-1')).toMatchObject({ workspaceId: 'harbor', workspaceSetBy: 'rule' });
    expect(await db.threads.get('notes')).toMatchObject({ workspaceId: 'harbor', workspaceSetBy: 'rule' });
    expect((await db.kbItems.get('meeting:meet-1'))?.workspaceId).toBe('harbor');
  });

  it('moves a saved page with who placed it, and says false for something gone', async () => {
    await db.kbItems.add(kbItem('page:p1', 'page'));
    expect(await source.set({ kind: 'kb', id: 'page:p1' }, 'orchid', 'rule')).toBe(true);
    expect(await db.kbItems.get('page:p1')).toMatchObject({ workspaceId: 'orchid', workspaceSetBy: 'rule' });
    expect(await source.set({ kind: 'kb', id: 'page:missing' }, 'orchid', 'rule')).toBe(false);
    expect(await source.set({ kind: 'thread', id: 'nope' }, 'orchid', 'rule')).toBe(false);
  });

  it('writes only when the thing is still as it was read, whatever kind it is', async () => {
    const tasks = createTaskStore(db);
    const { task } = (await tasks.record({ title: 'Do it', workspaceId: null, source: { kind: 'chat' } }))!;
    await db.threads.add(newThread({ id: 'chat-1' }));
    await db.threads.add(newThread({ id: 'notes', meetingId: 'meet-1' }));
    await db.meetings.add(newMeeting({ id: 'meet-1', status: 'done', threadId: 'notes' }));
    await db.kbItems.add(kbItem('page:p1', 'page'));
    const refs = [
      { kind: 'task', id: task.id },
      { kind: 'thread', id: 'chat-1' },
      { kind: 'meeting', id: 'meet-1' },
      { kind: 'kb', id: 'page:p1' },
    ] as const;
    // Each was read as in no workspace, placed by a rule (a task) or by no one; then Avi placed each himself
    const read = { workspaceId: null, setBy: null } as const;
    await db.tasks.update(task.id, { workspaceId: 'harbor', workspaceSetBy: 'avi' });
    await db.threads.update('chat-1', { workspaceId: 'harbor', workspaceSetBy: 'avi' });
    await db.meetings.update('meet-1', { workspaceId: 'harbor', workspaceSetBy: 'avi' });
    await db.kbItems.update('page:p1', { workspaceId: 'harbor', workspaceSetBy: 'avi' });
    for (const ref of refs) {
      const stale = ref.kind === 'task' ? { workspaceId: null, setBy: 'rule' as const } : read;
      expect(await source.set(ref, 'orchid', 'rule', stale), ref.kind).toBe(false);
    }
    expect(await db.tasks.get(task.id)).toMatchObject({ workspaceId: 'harbor', workspaceSetBy: 'avi' });
    expect(await db.threads.get('chat-1')).toMatchObject({ workspaceId: 'harbor', workspaceSetBy: 'avi' });
    expect(await db.meetings.get('meet-1')).toMatchObject({ workspaceId: 'harbor', workspaceSetBy: 'avi' });
    expect((await db.threads.get('notes'))?.workspaceId ?? null).toBeNull();
    expect(await db.kbItems.get('page:p1')).toMatchObject({ workspaceId: 'harbor', workspaceSetBy: 'avi' });
    // As read, it writes
    const now = { workspaceId: 'harbor', setBy: 'avi' as const };
    for (const ref of refs) expect(await source.set(ref, 'orchid', 'avi', now), ref.kind).toBe(true);
  });

  it('counts what is in a workspace, done or not, of every kind', async () => {
    const tasks = createTaskStore(db);
    const made = await tasks.record({ title: 'Closed task', workspaceId: 'orchid', source: { kind: 'chat' } });
    await tasks.setStatus(made!.task.id, 'done', 'avi');
    expect(await source.countIn('orchid')).toBe(1);
    await db.threads.add(newThread({ id: 'c', workspaceId: 'orchid' }));
    await db.meetings.add(newMeeting({ id: 'm', workspaceId: 'orchid' }));
    await db.kbItems.add(kbItem('page:p', 'page', { workspaceId: 'orchid' }));
    expect(await source.countIn('orchid')).toBe(4);
    expect(await source.countIn('harbor')).toBe(0);
  });
});

describe('the whole flow over the real database', () => {
  const rigDeps = (): PlaceDeps => {
    let stored = emptyPlacementState();
    const book = [ORCHID, { ...ORCHID, id: 'harbor', name: 'Harbor' }];
    return {
      items: source,
      placement: createPlacementStore({
        get: async () => structuredClone(stored),
        set: async state => {
          stored = structuredClone(state);
        },
      }),
      workspaces: {
        list: async () => [...book],
        save: async next => void book.push(next),
        remove: async id =>
          void book.splice(
            book.findIndex(one => one.id === id),
            1,
          ),
      },
      inbox: { add: async () => undefined, close: async () => undefined },
    };
  };

  it('makes a workspace from three kinds of thing, then undoes it back to the start', async () => {
    const tasks = createTaskStore(db);
    const { task } = (await tasks.record({
      title: 'Lead Engine brief',
      workspaceId: null,
      workspaceSetBy: 'rule',
      source: { kind: 'chat' },
    }))!;
    await db.threads.add(newThread({ id: 'chat-1', title: 'Lead Engine chat' }));
    await db.kbItems.add(kbItem('note:n1', 'note', { title: 'Lead Engine note' }));
    const deps = rigDeps();
    const made = await makeWorkspace(deps, {
      name: 'Lead Engine',
      refs: [
        { kind: 'task', id: task.id },
        { kind: 'thread', id: 'chat-1' },
        { kind: 'kb', id: 'note:n1' },
      ],
      by: 'sheet',
    });
    if (made.kind !== 'made') throw new Error('expected a new workspace');
    expect(made.move.items).toHaveLength(3);
    expect(await db.tasks.get(task.id)).toMatchObject({ workspaceId: 'lead-engine', workspaceSetBy: 'avi' });
    expect(await db.threads.get('chat-1')).toMatchObject({ workspaceId: 'lead-engine', workspaceSetBy: 'avi' });
    expect(await db.kbItems.get('note:n1')).toMatchObject({ workspaceId: 'lead-engine', workspaceSetBy: 'avi' });

    expect(await undoMove(deps, made.move.id, INBOX_UNDO_MS)).toEqual({
      ok: true,
      restored: 3,
      left: 0,
      removedWorkspace: true,
    });
    expect(await db.tasks.get(task.id)).toMatchObject({ workspaceId: null, workspaceSetBy: 'rule' });
    expect((await db.threads.get('chat-1'))?.workspaceId).toBeNull();
    expect((await db.threads.get('chat-1'))?.workspaceSetBy).toBeUndefined();
    expect(await db.kbItems.get('note:n1')).toMatchObject({ workspaceId: null });
    expect((await db.kbItems.get('note:n1'))?.workspaceSetBy).toBeUndefined();
  });

  it('never moves something Avi placed, even when a rule move asks for it', async () => {
    await db.threads.add(newThread({ id: 'mine', workspaceId: 'orchid', workspaceSetBy: 'avi' }));
    await db.threads.add(newThread({ id: 'kept-none', workspaceId: null, workspaceSetBy: 'avi' }));
    await db.meetings.add(newMeeting({ id: 'm', workspaceId: 'orchid', workspaceSetBy: 'avi' }));
    const deps = rigDeps();
    const { move } = await moveItems(deps, {
      refs: [
        { kind: 'thread', id: 'mine' },
        { kind: 'thread', id: 'kept-none' },
        { kind: 'meeting', id: 'm' },
      ],
      workspace: { ...ORCHID, id: 'harbor', name: 'Harbor' },
      by: 'rule',
      setBy: 'rule',
    });
    expect(move).toBeNull();
    expect((await db.threads.get('mine'))?.workspaceId).toBe('orchid');
    expect((await db.threads.get('kept-none'))?.workspaceId).toBeNull();
    expect((await db.meetings.get('m'))?.workspaceId).toBe('orchid');
  });

  it('answers an offer by moving only what is still where it was', async () => {
    await db.threads.add(newThread({ id: 'a', title: 'A' }));
    await db.threads.add(newThread({ id: 'b', title: 'B' }));
    const deps = rigDeps();
    const offer = await makeOffer(deps, { kind: 'guess', workspace: ORCHID, items: await source.list() });
    // Avi puts B in another workspace himself before answering
    await source.set({ kind: 'thread', id: 'b' }, 'harbor', 'avi');
    const result = await acceptOffer(deps, offer!.id);
    expect(result).toMatchObject({ moved: 1, skipped: 1 });
    expect(await db.threads.get('b')).toMatchObject({ workspaceId: 'harbor', workspaceSetBy: 'avi' });
  });
});
