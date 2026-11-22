import { describe, expect, it } from 'vitest';
import {
  acceptOffer,
  dismissOffer,
  INBOX_UNDO_MS,
  makeOffer,
  makeWorkspace,
  moveItems,
  TOAST_UNDO_MS,
  undoMove,
  unplacedItems,
} from '../place';
import { HARBOR, item, ORCHID, rig } from './fixtures';

describe('moveItems', () => {
  it('moves things and records where each was, for the undo', async () => {
    const deps = rig([item('1', 'a'), item('2', 'b', { workspaceId: 'harbor', setBy: 'rule' })]);
    const { move } = await moveItems(deps, {
      refs: [
        { kind: 'task', id: '1' },
        { kind: 'task', id: '2' },
      ],
      workspace: ORCHID,
      by: 'rule',
      setBy: 'rule',
    });
    expect(move?.items).toEqual([
      { kind: 'task', id: '1', fromWorkspaceId: null, fromSetBy: null, toSetBy: 'rule' },
      { kind: 'task', id: '2', fromWorkspaceId: 'harbor', fromSetBy: 'rule', toSetBy: 'rule' },
    ]);
    expect(deps.source.at('1')).toMatchObject({ workspaceId: 'orchid', setBy: 'rule' });
  });

  it('never moves a thing Avi placed for a rule or for Ava', async () => {
    const deps = rig([item('1', 'a', { workspaceId: 'harbor', setBy: 'avi' }), item('2', 'b', { setBy: 'avi' })]);
    for (const setBy of ['rule', 'ava'] as const) {
      const { move, skipped } = await moveItems(deps, {
        refs: [
          { kind: 'task', id: '1' },
          { kind: 'task', id: '2' },
        ],
        workspace: ORCHID,
        by: 'rule',
        setBy,
      });
      expect(move).toBeNull();
      expect(skipped).toBe(2);
    }
    expect(deps.source.moved).toEqual([]);
    expect(await deps.placement.state().then(state => state.moves)).toEqual([]);
  });

  it('skips a thing that is no longer where it was offered from', async () => {
    const deps = rig([item('1', 'a'), item('2', 'b', { workspaceId: 'harbor', setBy: 'avi' })]);
    const { move, skipped } = await moveItems(deps, {
      refs: [
        { kind: 'task', id: '1' },
        { kind: 'task', id: '2' },
      ],
      workspace: ORCHID,
      by: 'offer',
      setBy: 'avi',
      // Both were in no workspace when offered; Avi has since put the second in Harbor
      expectFrom: new Map([
        ['task:1', null],
        ['task:2', null],
      ]),
    });
    expect(move?.items.map(one => one.id)).toEqual(['1']);
    expect(skipped).toBe(1);
    expect(deps.source.at('2').workspaceId).toBe('harbor');
  });
});

describe('undoMove', () => {
  it('puts back each thing and who had placed it', async () => {
    const deps = rig([item('1', 'a', { setBy: 'ava' }), item('2', 'b', { workspaceId: 'harbor', setBy: 'rule' })]);
    const { move } = await moveItems(deps, {
      refs: [
        { kind: 'task', id: '1' },
        { kind: 'task', id: '2' },
      ],
      workspace: ORCHID,
      by: 'rule',
      setBy: 'rule',
    });
    const result = await undoMove(deps, move!.id, INBOX_UNDO_MS);
    expect(result).toEqual({ ok: true, restored: 2, left: 0, removedWorkspace: false });
    expect(deps.source.at('1')).toMatchObject({ workspaceId: null, setBy: 'ava' });
    expect(deps.source.at('2')).toMatchObject({ workspaceId: 'harbor', setBy: 'rule' });
  });

  it('leaves a thing Avi has moved since where he put it', async () => {
    const deps = rig([item('1', 'a'), item('2', 'b')]);
    const { move } = await moveItems(deps, {
      refs: [
        { kind: 'task', id: '1' },
        { kind: 'task', id: '2' },
      ],
      workspace: ORCHID,
      by: 'rule',
      setBy: 'rule',
    });
    await deps.source.set({ kind: 'task', id: '2' }, 'harbor', 'avi');
    const result = await undoMove(deps, move!.id, INBOX_UNDO_MS);
    expect(result).toMatchObject({ ok: true, restored: 1, left: 1 });
    expect(deps.source.at('2')).toMatchObject({ workspaceId: 'harbor', setBy: 'avi' });
  });

  it('works once, and only while it is recent enough', async () => {
    const deps = rig([item('1', 'a')]);
    const { move } = await moveItems(deps, {
      refs: [{ kind: 'task', id: '1' }],
      workspace: ORCHID,
      by: 'rule',
      setBy: 'rule',
    });
    deps.clock.now += TOAST_UNDO_MS + 1;
    expect(await undoMove(deps, move!.id, TOAST_UNDO_MS)).toEqual({ ok: false, reason: 'late' });
    expect(await undoMove(deps, move!.id, INBOX_UNDO_MS)).toMatchObject({ ok: true });
    expect(await undoMove(deps, move!.id, INBOX_UNDO_MS)).toEqual({ ok: false, reason: 'already' });
    expect(await undoMove(deps, 'wsm_aaaaaaaaaa', INBOX_UNDO_MS)).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('makeWorkspace', () => {
  it('makes the workspace and moves the ticked things as Avi’s own placing, with one undo', async () => {
    const deps = rig([item('1', 'Lead Engine brief'), item('2', 'Lead Engine call', { kind: 'meeting' })]);
    const made = await makeWorkspace(deps, {
      name: '  Lead   Engine ',
      keywords: ['lead engine'],
      refs: [
        { kind: 'task', id: '1' },
        { kind: 'meeting', id: '2' },
      ],
      by: 'sheet',
    });
    expect(made.kind).toBe('made');
    if (made.kind !== 'made') return;
    expect(made.workspace).toMatchObject({ id: 'lead-engine', name: 'Lead Engine', keywords: ['lead engine'] });
    expect(deps.book.map(one => one.id)).toEqual(['orchid', 'harbor', 'lead-engine']);
    expect(deps.source.at('1')).toMatchObject({ workspaceId: 'lead-engine', setBy: 'avi' });
    expect(deps.source.at('2', 'meeting')).toMatchObject({ workspaceId: 'lead-engine', setBy: 'avi' });
    expect(deps.inboxItems).toHaveLength(1);
    expect(deps.inboxItems[0]).toMatchObject({ source: 'workspaces', externalId: made.move.id });

    const undone = await undoMove(deps, made.move.id, INBOX_UNDO_MS);
    expect(undone).toEqual({ ok: true, restored: 2, left: 0, removedWorkspace: true });
    expect(deps.book.map(one => one.id)).toEqual(['orchid', 'harbor']);
    expect(deps.source.at('1')).toMatchObject({ workspaceId: null, setBy: null });
    expect(deps.closed).toContain(`workspaces|${made.move.id}`);
  });

  it('moves only what is still in no workspace', async () => {
    const deps = rig([item('1', 'a'), item('2', 'b', { workspaceId: 'harbor', setBy: 'avi' })]);
    const made = await makeWorkspace(deps, {
      name: 'Newco',
      refs: [
        { kind: 'task', id: '1' },
        { kind: 'task', id: '2' },
      ],
      by: 'sheet',
    });
    expect(made).toMatchObject({ kind: 'made', skipped: 1 });
    expect(deps.source.at('2')).toMatchObject({ workspaceId: 'harbor', setBy: 'avi' });
  });

  it('does not make a name twice, however it is spelled', async () => {
    const deps = rig([]);
    for (const name of ['Harbor', 'harbor', ' HARBOR. ']) {
      const made = await makeWorkspace(deps, { name, by: 'voice' });
      expect(made).toMatchObject({ kind: 'exists', workspace: { id: 'harbor' } });
    }
    expect(deps.book).toHaveLength(2);
  });

  it('keeps a made workspace when something else is in it by the time of the undo', async () => {
    const deps = rig([item('1', 'a')]);
    const made = await makeWorkspace(deps, { name: 'Newco', by: 'voice' });
    if (made.kind !== 'made') throw new Error('expected a new workspace');
    await deps.source.set({ kind: 'task', id: '1' }, 'newco', 'avi');
    expect(await undoMove(deps, made.move.id, INBOX_UNDO_MS)).toMatchObject({ ok: true, removedWorkspace: false });
    expect(deps.book.map(one => one.id)).toContain('newco');
  });

  it('refuses an empty name', async () => {
    await expect(makeWorkspace(rig([]), { name: '   ', by: 'sheet' })).rejects.toThrow('needs a name');
  });
});

describe('offers', () => {
  it('are offered in the Inbox once and never move anything until Avi says yes', async () => {
    const deps = rig([item('1', 'Orchid a'), item('2', 'Orchid b')]);
    const things = await deps.source.list();
    const first = await makeOffer(deps, { kind: 'guess', workspace: ORCHID, items: things });
    const again = await makeOffer(deps, { kind: 'guess', workspace: ORCHID, items: things });
    expect(first?.id).toBeTruthy();
    expect(again).toBeNull();
    expect(deps.inboxItems).toHaveLength(1);
    expect(deps.inboxItems[0].title).toBe('Move these 2 to Orchid Labs?');
    expect(deps.inboxItems[0].body).toContain('These 2 look like Orchid Labs.');
    expect(deps.source.moved).toEqual([]);
  });

  it('move the things still where they were, as Avi’s own placing', async () => {
    const deps = rig([item('1', 'a'), item('2', 'b')]);
    const offer = (await makeOffer(deps, { kind: 'guess', workspace: ORCHID, items: await deps.source.list() }))!;
    await deps.source.set({ kind: 'task', id: '2' }, 'harbor', 'avi');
    const result = await acceptOffer(deps, offer.id);
    expect(result).toMatchObject({ moved: 1, skipped: 1, workspaceName: 'Orchid Labs' });
    expect(deps.source.at('1')).toMatchObject({ workspaceId: 'orchid', setBy: 'avi' });
    expect(deps.source.at('2')).toMatchObject({ workspaceId: 'harbor', setBy: 'avi' });
    await expect(acceptOffer(deps, offer.id)).rejects.toThrow('answered already');
  });

  it('record what Avi unticked as a no for that workspace', async () => {
    const deps = rig([item('1', 'a'), item('2', 'b')]);
    const offer = (await makeOffer(deps, { kind: 'guess', workspace: ORCHID, items: await deps.source.list() }))!;
    await acceptOffer(deps, offer.id, [{ kind: 'task', id: '1' }]);
    expect((await deps.state()).declined).toEqual(['task:2>orchid']);
    expect(deps.source.at('2').workspaceId).toBeNull();
  });

  it('are closed by a no, and the same things are not offered for that workspace again', async () => {
    const deps = rig([item('1', 'a'), item('2', 'b')]);
    const offer = (await makeOffer(deps, { kind: 'wrong', workspace: HARBOR, items: await deps.source.list() }))!;
    await dismissOffer(deps, offer.id);
    const state = await deps.state();
    expect(state.offers[0].status).toBe('dismissed');
    expect(state.declined).toEqual(['task:1>harbor', 'task:2>harbor']);
    expect(deps.closed).toContain(`workspaces|${offer.id}`);
  });

  it('say a wrong-workspace offer in its own words', async () => {
    const deps = rig([item('1', 'Orchid quote', { workspaceId: 'harbor', setBy: 'rule' })]);
    await makeOffer(deps, { kind: 'wrong', workspace: ORCHID, items: await deps.source.list() });
    expect(deps.inboxItems[0].title).toBe('Move it to Orchid Labs?');
    expect(deps.inboxItems[0].body).toContain('may belong in Orchid Labs');
  });
});

describe('unplacedItems', () => {
  it('lists what sits in no workspace: tasks first, then chats, meetings and knowledge', async () => {
    const deps = rig([
      item('k', 'Zed page', { kind: 'kb' }),
      item('m', 'A call', { kind: 'meeting' }),
      item('t2', 'B task'),
      item('t1', 'A task'),
      item('c', 'A chat', { kind: 'thread' }),
      item('placed', 'Placed', { workspaceId: 'harbor', setBy: 'rule' }),
      item('gone', 'Workspace deleted', { workspaceId: 'deleted', setBy: 'rule' }),
    ]);
    const list = await unplacedItems(deps);
    expect(list.map(one => `${one.ref.kind}:${one.ref.id}`)).toEqual([
      'task:t1',
      'task:t2',
      'task:gone',
      'thread:c',
      'meeting:m',
      'kb:k',
    ]);
  });
});
