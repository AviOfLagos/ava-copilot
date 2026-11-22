import { describe, expect, it } from 'vitest';
import { createPlacementStore, declinedKey, emptyPlacementState, isMoveId, isOfferId } from '../placement';
import type { PlacementState } from '../placement';
import {
  MAKE_WORKSPACE_LINE,
  parseWorkspaceLine,
  splitWorkspaceLines,
  stripWorkspaceMarkers,
  undoMoveLine,
} from '../markers';
import { stripTaskMarkers } from '../../tasks/markers';
import { matchWorkspaces, routeWorkspace } from '../workspaces';
import type { Workspace } from '../workspaces';

const memory = () => {
  let state: PlacementState = emptyPlacementState();
  return {
    get: async () => structuredClone(state),
    set: async (next: PlacementState) => {
      state = structuredClone(next);
    },
  };
};

const move = (overrides: Record<string, unknown> = {}) => ({
  by: 'rule' as const,
  workspaceId: 'ws-a',
  workspaceName: 'Orchid Labs',
  createdWorkspace: false,
  items: [{ kind: 'task' as const, id: 'tsk_1', fromWorkspaceId: null, fromSetBy: null, toSetBy: 'rule' as const }],
  ...overrides,
});

describe('the placement store', () => {
  it('keeps a move once, with an id the panel can name, and marks it undone once', async () => {
    let clock = 1000;
    const store = createPlacementStore(memory(), () => clock);
    const made = await store.addMove(move());
    expect(isMoveId(made.id)).toBe(true);
    expect(made).toMatchObject({ at: 1000, undoneAt: null, reportedAt: null });
    clock = 2000;
    expect((await store.markUndone(made.id))?.undoneAt).toBe(2000);
    expect(await store.markUndone(made.id)).toBeUndefined();
    expect((await store.getMove(made.id))?.undoneAt).toBe(2000);
  });

  it('tells a rule move once: not when undone, not when reported, not when other people moved things', async () => {
    const store = createPlacementStore(memory());
    const one = await store.addMove(move());
    const undone = await store.addMove(move());
    await store.addMove(move({ by: 'sheet' }));
    await store.addMove(move({ items: [] }));
    await store.markUndone(undone.id);
    expect((await store.unreportedRuleMoves()).map(item => item.id)).toEqual([one.id]);
    await store.markReported([one.id]);
    expect(await store.unreportedRuleMoves()).toEqual([]);
  });

  it('does not offer the same things for the same workspace twice while the first waits', async () => {
    const store = createPlacementStore(memory());
    const offer = {
      kind: 'guess' as const,
      workspaceId: 'ws-a',
      workspaceName: 'Orchid Labs',
      items: [
        { kind: 'task' as const, id: 'tsk_1', title: 'One', fromWorkspaceId: null },
        { kind: 'task' as const, id: 'tsk_2', title: 'Two', fromWorkspaceId: null },
      ],
    };
    const first = await store.addOffer(offer);
    const again = await store.addOffer({ ...offer, items: [...offer.items].reverse() });
    expect(isOfferId(first.offer.id)).toBe(true);
    expect(first.added).toBe(true);
    expect(again).toMatchObject({ added: false, offer: { id: first.offer.id } });
    // For another workspace it is a new offer
    expect((await store.addOffer({ ...offer, workspaceId: 'ws-b' })).added).toBe(true);
  });

  it('closes an offer once; a no is remembered per item and workspace', async () => {
    const store = createPlacementStore(memory());
    const { offer } = await store.addOffer({
      kind: 'wrong',
      workspaceId: 'ws-a',
      workspaceName: 'Orchid Labs',
      items: [{ kind: 'meeting', id: 'm1', title: 'Call', fromWorkspaceId: 'ws-b' }],
    });
    expect((await store.resolveOffer(offer.id, { status: 'dismissed' }))?.status).toBe('dismissed');
    expect(await store.resolveOffer(offer.id, { status: 'dismissed' })).toBeUndefined();
    expect((await store.state()).declined).toEqual([declinedKey({ kind: 'meeting', id: 'm1' }, 'ws-a')]);
    expect(await store.openOffers()).toEqual([]);
  });

  it('keeps only the latest records, and two writes at once both land', async () => {
    const store = createPlacementStore(memory());
    await Promise.all(Array.from({ length: 70 }, () => store.addMove(move())));
    expect((await store.state()).moves).toHaveLength(60);
    await store.markGuessed([{ kind: 'task', id: 'tsk_1' }]);
    expect(Object.keys((await store.state()).guessed)).toEqual(['task:tsk_1']);
  });
});

describe('workspace lines', () => {
  const id = 'wsm_abcdefghij';

  it('are told apart from text', () => {
    expect(parseWorkspaceLine(MAKE_WORKSPACE_LINE)).toEqual({ kind: 'make' });
    expect(parseWorkspaceLine(undoMoveLine(id))).toEqual({ kind: 'undo', moveId: id });
    expect(parseWorkspaceLine('^ws_undo_notanid')).toBeNull();
    expect(parseWorkspaceLine('Moved 3 things ^ws_make')).toBeNull();
  });

  it('are taken out of text, wherever it goes (WhatsApp, voice, copy, the knowledge base)', () => {
    const text = `**No workspace**\n${MAKE_WORKSPACE_LINE}\n\nMoved 3 things to Harbor.\n${undoMoveLine(id)}\nDone`;
    expect(stripWorkspaceMarkers(text)).toBe('**No workspace**\n\nMoved 3 things to Harbor.\nDone');
    expect(stripTaskMarkers(text)).toBe(stripWorkspaceMarkers(text));
    expect(stripWorkspaceMarkers('plain')).toBe('plain');
  });

  it('are split into text and buttons, and left alone inside a code block', () => {
    const text = [
      'Moved 2 things to Harbor.',
      undoMoveLine(id),
      'Then:',
      '```',
      MAKE_WORKSPACE_LINE,
      '```',
      MAKE_WORKSPACE_LINE,
    ].join('\n');
    expect(splitWorkspaceLines(text)).toEqual([
      { kind: 'markdown', text: 'Moved 2 things to Harbor.' },
      { kind: 'undo', moveId: id },
      { kind: 'markdown', text: `Then:\n\`\`\`\n${MAKE_WORKSPACE_LINE}\n\`\`\`` },
      { kind: 'make' },
    ]);
    expect(splitWorkspaceLines('no buttons')).toEqual([{ kind: 'markdown', text: 'no buttons' }]);
  });
});

describe('matchWorkspaces', () => {
  const ws = (id: string, name: string, keywords: string[] = []): Workspace => ({
    id,
    name,
    about: '',
    keywords,
    accounts: {},
    createdAt: 0,
  });
  const all = [ws('a', 'Orchid Labs', ['orchid']), ws('b', 'Harbor'), ws('c', 'Dock', ['harbor'])];

  it('lists every workspace a text points at; routeWorkspace needs exactly one', () => {
    expect(matchWorkspaces('Harbor call', all).map(item => item.id)).toEqual(['b', 'c']);
    expect(routeWorkspace('Harbor call', all)).toBeNull();
    expect(routeWorkspace('Orchid launch', all)?.id).toBe('a');
    expect(matchWorkspaces('nothing here', all)).toEqual([]);
  });
});
