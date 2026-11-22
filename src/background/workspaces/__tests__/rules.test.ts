import { describe, expect, it } from 'vitest';
import { evidenceFor, looselyMatching, planSort, workspaceByParticipants } from '../rules';
import type { SortInput } from '../rules';
import { HARBOR, item, ORCHID, person, workspace } from './fixtures';

const input = (items: SortInput['items'], extra: Partial<SortInput> = {}): SortInput => ({
  items,
  workspaces: [ORCHID, HARBOR],
  people: [],
  declined: new Set(),
  reserved: new Set(),
  ...extra,
});

describe('evidenceFor', () => {
  it('reads a workspace name, a keyword and a Google domain, as whole words', () => {
    const acme = workspace('acme', 'Acme', [], 'ada@acme-labs.example');
    const all = [ORCHID, HARBOR, acme];
    expect(evidenceFor(item('1', 'Draft the Orchid Labs deck'), all, [])).toEqual(['orchid']);
    expect(evidenceFor(item('2', 'Book the dockside crane'), all, [])).toEqual(['harbor']);
    expect(evidenceFor(item('3', 'Invoice from billing@acme-labs.example'), all, [])).toEqual(['acme']);
    expect(evidenceFor(item('4', 'Orchids need water'), all, [])).toEqual([]);
  });

  it('counts a person only when they belong to exactly one workspace', () => {
    const solo = person('Ada Obi', ['harbor']);
    const both = person('Kunle Bello', ['harbor', 'orchid']);
    expect(evidenceFor(item('1', 'Send the draft', { names: ['Ada Obi'] }), [ORCHID, HARBOR], [solo, both])).toEqual([
      'harbor',
    ]);
    expect(
      evidenceFor(item('2', 'Send the draft', { names: ['Kunle Bello'] }), [ORCHID, HARBOR], [solo, both]),
    ).toEqual([]);
  });

  it('is unclear when words and people point at different workspaces', () => {
    const ada = person('Ada Obi', ['harbor']);
    const found = evidenceFor(item('1', 'Orchid launch', { names: ['Ada Obi'] }), [ORCHID, HARBOR], [ada]);
    expect(found.sort()).toEqual(['harbor', 'orchid']);
  });
});

describe('workspaceByParticipants', () => {
  const ada = person('Ada Obi', ['harbor']);
  const kunle = person('Kunle Bello', ['harbor']);
  const tola = person('Tola Ade', ['orchid']);
  const both = person('Dayo Ige', ['harbor', 'orchid']);
  const all = [ORCHID, HARBOR];

  it('picks the workspace most known participants belong to, and ignores people Ava does not know', () => {
    expect(
      workspaceByParticipants(['Ada Obi', 'Kunle Bello', 'Tola Ade', 'Stranger'], [ada, kunle, tola], all)?.id,
    ).toBe('harbor');
  });

  it('needs more than half: a tie picks nothing', () => {
    expect(workspaceByParticipants(['Ada Obi', 'Tola Ade'], [ada, tola], all)).toBeNull();
  });

  it('counts someone in two workspaces for both, so they never settle it alone', () => {
    expect(workspaceByParticipants(['Dayo Ige'], [both], all)).toBeNull();
    expect(workspaceByParticipants(['Dayo Ige', 'Ada Obi'], [both, ada], all)?.id).toBe('harbor');
  });

  it('knows nobody: nothing', () => {
    expect(workspaceByParticipants(['Stranger'], [ada], all)).toBeNull();
    expect(workspaceByParticipants([], [ada], all)).toBeNull();
  });

  it('is evidence for a meeting', () => {
    const meeting = item('m1', '', { kind: 'meeting', names: ['Ada Obi', 'Kunle Bello'] });
    expect(evidenceFor(meeting, all, [ada, kunle])).toEqual(['harbor']);
  });
});

describe('planSort: things in no workspace', () => {
  it('moves two or more that fit exactly one workspace', () => {
    const plan = planSort(input([item('1', 'Orchid pricing page'), item('2', 'Call Orchid Labs about the quote')]));
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0].workspace.id).toBe('orchid');
    expect(plan.moves[0].items.map(one => one.ref.id)).toEqual(['1', '2']);
  });

  it('does not move a single thing', () => {
    expect(planSort(input([item('1', 'Orchid pricing page'), item('2', 'Buy milk')])).moves).toEqual([]);
  });

  it('does not move what fits two workspaces', () => {
    const plan = planSort(
      input([
        item('1', 'Orchid and Harbor joint call'),
        item('2', 'Orchid and Harbor budget'),
        item('3', 'Orchid plan'),
      ]),
    );
    expect(plan.moves).toEqual([]);
  });

  it('never moves a thing Avi placed, even one he left in no workspace', () => {
    const plan = planSort(
      input([
        item('1', 'Orchid pricing page', { setBy: 'avi' }),
        item('2', 'Orchid launch'),
        item('3', 'Orchid tasks'),
      ]),
    );
    expect(plan.moves[0].items.map(one => one.ref.id)).toEqual(['2', '3']);
  });

  it('counts a workspace since deleted as none', () => {
    const plan = planSort(
      input([
        item('1', 'Orchid pricing page', { workspaceId: 'gone', setBy: 'rule' }),
        item('2', 'Orchid launch', { workspaceId: 'gone', setBy: 'rule' }),
      ]),
    );
    expect(plan.moves).toHaveLength(1);
  });

  it('leaves out what Avi turned down, and what already waits in an offer', () => {
    const declined = new Set(['task:1>orchid']);
    const reserved = new Set(['task:2']);
    const plan = planSort(
      input([item('1', 'Orchid a'), item('2', 'Orchid b'), item('3', 'Orchid c'), item('4', 'Orchid d')], {
        declined,
        reserved,
      }),
    );
    expect(plan.moves[0].items.map(one => one.ref.id)).toEqual(['3', '4']);
  });

  it('lists what no rule points at, for a model to guess about', () => {
    const plan = planSort(input([item('1', 'Buy milk'), item('2', 'Orchid launch')]));
    expect(plan.unclear.map(one => one.ref.id)).toEqual(['1']);
  });

  it('moves things by their owner when the owner belongs to one workspace', () => {
    const ada = person('Ada Obi', ['harbor']);
    const plan = planSort(
      input([item('1', 'Send it', { names: ['Ada Obi'] }), item('2', 'Check it', { names: ['Ada Obi'] })], {
        people: [ada],
      }),
    );
    expect(plan.moves[0].workspace.id).toBe('harbor');
  });
});

describe('planSort: things in the wrong workspace', () => {
  it('offers things a rule or Ava placed that fit exactly one other workspace and not their own', () => {
    const plan = planSort(
      input([
        item('1', 'Orchid quote', { workspaceId: 'harbor', setBy: 'rule' }),
        item('2', 'Orchid deck', { workspaceId: 'harbor', setBy: 'ava' }),
      ]),
    );
    expect(plan.moves).toEqual([]);
    expect(plan.wrong).toHaveLength(1);
    expect(plan.wrong[0].items.map(one => one.ref.id)).toEqual(['1', '2']);
  });

  it('offers nothing when its own workspace fits it too', () => {
    const plan = planSort(input([item('1', 'Orchid and Harbor', { workspaceId: 'harbor', setBy: 'rule' })]));
    expect(plan.wrong).toEqual([]);
  });

  it('never offers what Avi placed, nor what nobody recorded', () => {
    const plan = planSort(
      input([
        item('1', 'Orchid quote', { workspaceId: 'harbor', setBy: 'avi' }),
        item('2', 'Orchid deck', { workspaceId: 'harbor', setBy: null }),
      ]),
    );
    expect(plan.wrong).toEqual([]);
  });
});

describe('looselyMatching', () => {
  it('finds things in no workspace that name a new workspace or one of its words', () => {
    const lead = workspace('lead-engine', 'Lead Engine');
    const found = looselyMatching(
      [
        item('1', 'Draft the Lead Engine brief'),
        item('2', 'The engine room checklist'),
        item('3', 'Lead Engine kickoff', { setBy: 'avi' }),
        item('4', 'Buy milk'),
        item('5', 'Orchid thing', { workspaceId: 'orchid', setBy: 'rule' }),
      ],
      lead,
      [ORCHID, HARBOR, lead],
    );
    expect(found.map(one => one.ref.id)).toEqual(['1', '2']);
  });
});
