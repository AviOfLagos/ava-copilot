import { describe, expect, it, vi } from 'vitest';
import { undoMove, RULE_UNDO_MS } from '../place';
import { sortUnplaced } from '../sort';
import type { SuggestModel } from '../suggest';
import { HARBOR, item, ORCHID, person, rig } from './fixtures';

const noModel = (): SuggestModel => ({ suggest: vi.fn(async () => null), guess: vi.fn(async () => []) });

describe('the sorting pass: rule moves', () => {
  it('moves two things that fit one workspace, marks them a rule’s, and records the move for the next brief', async () => {
    const deps = rig([item('1', 'Orchid pricing page'), item('2', 'Orchid quote'), item('3', 'Buy milk')]);
    const result = await sortUnplaced(deps);
    expect(result.moved).toHaveLength(1);
    expect(deps.source.at('1')).toMatchObject({ workspaceId: 'orchid', setBy: 'rule' });
    expect(deps.source.at('2')).toMatchObject({ workspaceId: 'orchid', setBy: 'rule' });
    expect(deps.source.at('3')).toMatchObject({ workspaceId: null });
    const state = await deps.state();
    expect(state.moves[0]).toMatchObject({ by: 'rule', workspaceId: 'orchid', reportedAt: null });
    // A rule move is told in the brief, not in the Inbox
    expect(deps.inboxItems).toEqual([]);
  });

  it('is reported once: after the brief tells it, the next pass has nothing to report', async () => {
    const deps = rig([item('1', 'Orchid pricing page'), item('2', 'Orchid quote')]);
    await sortUnplaced(deps);
    expect(await deps.placement.unreportedRuleMoves()).toHaveLength(1);
    await deps.placement.markReported((await deps.placement.unreportedRuleMoves()).map(move => move.id));
    expect(await deps.placement.unreportedRuleMoves()).toEqual([]);
    expect((await sortUnplaced(deps)).moved).toEqual([]);
    expect(await deps.placement.unreportedRuleMoves()).toEqual([]);
  });

  it('can be undone, is then not told in a brief, and is not done again by the next pass', async () => {
    const deps = rig([item('1', 'Orchid pricing page'), item('2', 'Orchid quote')]);
    const { moved } = await sortUnplaced(deps);
    await undoMove(deps, moved[0].id, RULE_UNDO_MS);
    expect(deps.source.at('1')).toMatchObject({ workspaceId: null, setBy: null });
    expect(await deps.placement.unreportedRuleMoves()).toEqual([]);
    expect((await sortUnplaced(deps)).moved).toEqual([]);
    expect(deps.source.at('1').workspaceId).toBeNull();
  });

  it('does not move what two workspaces fit, or a thing Avi placed', async () => {
    const deps = rig([
      item('1', 'Orchid and Harbor call'),
      item('2', 'Orchid and Harbor budget'),
      item('3', 'Orchid deck', { setBy: 'avi' }),
      item('4', 'Orchid launch', { setBy: 'avi' }),
    ]);
    expect((await sortUnplaced(deps)).moved).toEqual([]);
    expect(deps.source.moved).toEqual([]);
  });

  it('places a meeting when most of its known participants belong to one workspace', async () => {
    const ada = person('Ada Obi', ['harbor']);
    const kunle = person('Kunle Bello', ['harbor']);
    const deps = rig(
      [
        item('m1', '', { kind: 'meeting', names: ['Ada Obi', 'Kunle Bello'] }),
        item('m2', '', { kind: 'meeting', names: ['Ada Obi'] }),
      ],
      { people: [ada, kunle] },
    );
    await sortUnplaced(deps);
    expect(deps.source.at('m1', 'meeting')).toMatchObject({ workspaceId: 'harbor', setBy: 'rule' });
    expect(deps.source.at('m2', 'meeting')).toMatchObject({ workspaceId: 'harbor', setBy: 'rule' });
  });

  it('leaves things that wait in an open sheet alone for three days, then sorts them', async () => {
    const deps = rig([item('1', 'Orchid a'), item('2', 'Orchid b')]);
    await deps.placement.addOffer({
      kind: 'sheet',
      workspaceId: 'orchid',
      workspaceName: 'Orchid Labs',
      items: [
        { kind: 'task', id: '1', title: 'a', fromWorkspaceId: null },
        { kind: 'task', id: '2', title: 'b', fromWorkspaceId: null },
      ],
    });
    expect((await sortUnplaced(deps)).moved).toEqual([]);
    deps.clock.now += 4 * 24 * 60 * 60 * 1000;
    expect((await sortUnplaced(deps)).moved).toHaveLength(1);
  });

  it('does not move things Avi said no to for that workspace', async () => {
    const deps = rig([item('1', 'Orchid a'), item('2', 'Orchid b')]);
    await deps.placement.decline(
      [
        { kind: 'task', id: '1' },
        { kind: 'task', id: '2' },
      ],
      'orchid',
    );
    expect((await sortUnplaced(deps)).moved).toEqual([]);
  });
});

describe('the sorting pass: things in the wrong workspace', () => {
  it('offers them in the Inbox and moves nothing', async () => {
    const deps = rig([
      item('1', 'Orchid quote', { workspaceId: 'harbor', setBy: 'rule' }),
      item('2', 'Orchid deck', { workspaceId: 'harbor', setBy: 'ava' }),
    ]);
    const result = await sortUnplaced(deps);
    expect(result).toMatchObject({ moved: [], offered: 1 });
    expect(deps.source.moved).toEqual([]);
    expect(deps.inboxItems[0].title).toBe('Move these 2 to Orchid Labs?');
    // The same pass again does not offer the same thing twice
    expect((await sortUnplaced(deps)).offered).toBe(0);
    expect(deps.inboxItems).toHaveLength(1);
  });

  it('never offers a thing Avi placed', async () => {
    const deps = rig([
      item('1', 'Orchid quote', { workspaceId: 'harbor', setBy: 'avi' }),
      item('2', 'Orchid deck', { workspaceId: 'harbor', setBy: 'avi' }),
    ]);
    expect((await sortUnplaced(deps)).offered).toBe(0);
  });

  it('does not offer a thing two workspaces claim', async () => {
    const deps = rig([item('1', 'Orchid and Harbor', { workspaceId: 'harbor', setBy: 'rule' })]);
    expect((await sortUnplaced(deps)).offered).toBe(0);
  });
});

describe('the sorting pass: a model’s guess', () => {
  const things = () => [item('1', 'Ship the dockyard fix'), item('2', 'Dockyard invoice'), item('3', 'Buy milk')];

  it('is only offered, never moved', async () => {
    const model = noModel();
    model.guess = vi.fn(async () => [
      { n: 1, workspace: 'harbor' },
      { n: 2, workspace: 'harbor' },
      { n: 3, workspace: null },
    ]);
    const deps = rig(things(), { model });
    const result = await sortUnplaced(deps);
    expect(result).toMatchObject({ moved: [], offered: 1 });
    expect(deps.source.moved).toEqual([]);
    expect(deps.inboxItems[0].title).toBe('Move these 2 to Harbor?');
    expect((await deps.state()).offers[0]).toMatchObject({ kind: 'guess', workspaceId: 'harbor' });
  });

  it('offers nothing for a single guess, or for a workspace that does not exist', async () => {
    const model = noModel();
    model.guess = vi.fn(async () => [
      { n: 1, workspace: 'harbor' },
      { n: 2, workspace: 'made-up' },
      { n: 3, workspace: 'orchid' },
    ]);
    const deps = rig(things(), { model });
    expect((await sortUnplaced(deps)).offered).toBe(0);
  });

  it('does not ask again about the same things for two weeks, but asks again if the model failed', async () => {
    const model = noModel();
    model.guess = vi.fn(async () => []);
    const deps = rig(things(), { model });
    await sortUnplaced(deps);
    await sortUnplaced(deps);
    expect(model.guess).toHaveBeenCalledTimes(1);
    deps.clock.now += 15 * 24 * 60 * 60 * 1000;
    await sortUnplaced(deps);
    expect(model.guess).toHaveBeenCalledTimes(2);

    const failing = noModel();
    failing.guess = vi.fn(async () => {
      throw new Error('offline');
    });
    const other = rig(things(), { model: failing });
    await sortUnplaced(other);
    await sortUnplaced(other);
    expect(failing.guess).toHaveBeenCalledTimes(2);
  });

  it('is not asked at all when asked not to (the brief)', async () => {
    const model = noModel();
    const deps = rig(things(), { model });
    await sortUnplaced(deps, { guess: false });
    expect(model.guess).not.toHaveBeenCalled();
  });

  it('is not asked about a thing Avi placed, nor one a rule already settles', async () => {
    const model = noModel();
    model.guess = vi.fn(async () => []);
    const deps = rig(
      [
        item('1', 'Buy milk', { setBy: 'avi' }),
        item('2', 'Orchid quote'),
        item('3', 'Call the plumber'),
        item('4', 'Fix the sink'),
      ],
      { model },
    );
    await sortUnplaced(deps);
    const lines = (model.guess as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }[];
    expect(lines.map(line => line.text)).toEqual(['Call the plumber', 'Fix the sink']);
  });

  it('sees only the workspace list a model may pick from', async () => {
    const model = noModel();
    const deps = rig(things(), { model, workspaces: [ORCHID, HARBOR] });
    await sortUnplaced(deps);
    const known = (model.guess as ReturnType<typeof vi.fn>).mock.calls[0][1] as { id: string }[];
    expect(known.map(one => one.id)).toEqual(['orchid', 'harbor']);
  });
});
