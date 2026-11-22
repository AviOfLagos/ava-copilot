import { workspaceId as workspaceIdFor } from '@extension/storage';
import type {
  MoveBy,
  MovedItem,
  PlaceRef,
  PlacementStore,
  Workspace,
  WorkspaceMove,
  WorkspaceOffer,
  WorkspaceSetBy,
} from '@extension/storage';
import type { InboxDraft } from '../inbox/store';
import type { ItemSource } from './items';
import { isUnplaced } from './rules';
import type { PlaceItem } from './rules';

// Moving things between workspaces, and putting them back (docs/pm-desk.md, Part 3). Every move is recorded with where
// each thing was, so one undo restores exactly that: a thing Avi has moved since, by hand, is left where he put it.

export const WORKSPACES_SOURCE = 'workspaces';
// The toast after "Save" and after a voice command: thirty seconds. The Inbox keeps the undo for a day
export const TOAST_UNDO_MS = 30_000;
export const INBOX_UNDO_MS = 24 * 60 * 60 * 1000;
export const RULE_UNDO_MS = 7 * 24 * 60 * 60 * 1000;

export interface WorkspaceBook {
  list(): Promise<Workspace[]>;
  save(workspace: Workspace): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface PlaceDeps {
  items: ItemSource;
  placement: PlacementStore;
  workspaces: WorkspaceBook;
  // The Inbox: add an item, and close the one an answered offer or undone move left behind
  inbox: { add(draft: InboxDraft): Promise<unknown>; close(source: string, externalId: string): Promise<unknown> };
  now?: () => number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const things = (n: number) => plural(n, 'thing', 'things');

/** A name as one comparable string: case, spaces and punctuation do not make two workspaces. */
const same = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z0-9]+/g, '') === b.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function findByName(workspaces: Workspace[], name: string): Workspace | undefined {
  const wanted = name.trim();
  return wanted ? workspaces.find(workspace => same(workspace.name, wanted)) : undefined;
}

export interface MoveRequest {
  refs: PlaceRef[];
  workspace: Workspace;
  by: MoveBy;
  // Who is placing them: Avi's own click, or a rule or Ava
  setBy: WorkspaceSetBy;
  // Each thing must still be where it was when it was offered (null: in no workspace); anything that moved since,
  // Avi's own placing included, is left alone
  expectFrom?: Map<string, string | null>;
  createdWorkspace?: boolean;
}

export const keyOf = (ref: PlaceRef) => `${ref.kind}:${ref.id}`;

/**
 * Moves things into a workspace and records the move. A thing Avi placed is never moved for a rule or for Ava, and
 * a thing that is no longer where it was offered from is skipped. Returns the record (also with nothing moved, when
 * the workspace was just made; null when nothing moved) and how many were skipped.
 */
export async function moveItems(
  deps: PlaceDeps,
  request: MoveRequest,
): Promise<{ move: WorkspaceMove | null; skipped: number }> {
  const known = await deps.workspaces.list();
  const moved: MovedItem[] = [];
  let skipped = 0;
  for (const ref of request.refs) {
    const current = await deps.items.get(ref);
    if (!current) continue;
    const here = isUnplaced(current, known) ? null : current.workspaceId;
    if (request.setBy !== 'avi' && current.setBy === 'avi') {
      skipped++;
      continue;
    }
    if (request.expectFrom && request.expectFrom.get(keyOf(ref)) !== here) {
      skipped++;
      continue;
    }
    if (here === request.workspace.id) continue;
    if (!(await deps.items.set(ref, request.workspace.id, request.setBy))) continue;
    moved.push({ ...ref, fromWorkspaceId: current.workspaceId, fromSetBy: current.setBy, toSetBy: request.setBy });
  }
  // A move that moved nothing and made nothing is not worth an undo
  if (moved.length === 0 && !request.createdWorkspace) return { move: null, skipped };
  const move = await deps.placement.addMove({
    by: request.by,
    workspaceId: request.workspace.id,
    workspaceName: request.workspace.name,
    createdWorkspace: request.createdWorkspace ?? false,
    items: moved,
  });
  return { move, skipped };
}

export type UndoResult =
  | { ok: true; restored: number; left: number; removedWorkspace: boolean }
  | { ok: false; reason: 'unknown' | 'already' | 'late' };

/**
 * Puts a move back: each thing returns to where it was and to who had placed it, but only if it is still where the
 * move left it. A workspace the move made is removed again when nothing is in it, and what is put back is not moved
 * there again by a rule: an undo is a no.
 */
export async function undoMove(deps: PlaceDeps, moveId: string, maxAgeMs: number): Promise<UndoResult> {
  const move = await deps.placement.getMove(moveId);
  if (!move) return { ok: false, reason: 'unknown' };
  if (move.undoneAt !== null) return { ok: false, reason: 'already' };
  const now = deps.now ?? Date.now;
  if (now() - move.at > maxAgeMs) return { ok: false, reason: 'late' };
  // Claimed first: two clicks never restore twice
  if (!(await deps.placement.markUndone(moveId))) return { ok: false, reason: 'already' };
  let restored = 0;
  let left = 0;
  for (const item of move.items) {
    const current = await deps.items.get(item);
    if (!current) continue;
    if (current.workspaceId === move.workspaceId && current.setBy === item.toSetBy) {
      await deps.items.set(item, item.fromWorkspaceId, item.fromSetBy);
      restored++;
      // An undo is a no: a rule never puts this thing back there, nor is it offered there again
      await deps.placement.decline([item], move.workspaceId);
    } else {
      left++;
    }
  }
  let removedWorkspace = false;
  if (move.createdWorkspace && (await deps.items.countIn(move.workspaceId)) === 0) {
    await deps.workspaces.remove(move.workspaceId);
    removedWorkspace = true;
  }
  await deps.inbox.close(WORKSPACES_SOURCE, move.id);
  return { ok: true, restored, left, removedWorkspace };
}

export interface MakeRequest {
  name: string;
  keywords?: string[];
  about?: string;
  refs?: PlaceRef[];
  by: Extract<MoveBy, 'sheet' | 'voice' | 'agent'>;
}

export type MakeResult =
  | { kind: 'exists'; workspace: Workspace }
  | { kind: 'made'; workspace: Workspace; move: WorkspaceMove; skipped: number };

/**
 * Makes a workspace and moves the chosen things into it as one move, so one undo takes both back. A name that is
 * already a workspace's is not made twice. The things are Avi's choice: they are marked as his.
 */
export async function makeWorkspace(deps: PlaceDeps, request: MakeRequest): Promise<MakeResult> {
  const name = request.name.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) throw new Error('A workspace needs a name.');
  const existing = await deps.workspaces.list();
  const found = findByName(existing, name);
  if (found) return { kind: 'exists', workspace: found };
  const workspace: Workspace = {
    id: workspaceIdFor(
      name,
      existing.map(item => item.id),
    ),
    name,
    about: request.about?.trim() ?? '',
    keywords: request.keywords ?? [],
    accounts: {},
    createdAt: (deps.now ?? Date.now)(),
  };
  await deps.workspaces.save(workspace);
  const { move, skipped } = await moveItems(deps, {
    refs: request.refs ?? [],
    workspace,
    by: request.by,
    setBy: 'avi',
    // Only things still in no workspace come along
    expectFrom: new Map((request.refs ?? []).map(ref => [keyOf(ref), null])),
    createdWorkspace: true,
  });
  if (!move) throw new Error('The workspace was made but its record was not.');
  await deps.inbox.add({
    source: WORKSPACES_SOURCE,
    externalId: move.id,
    kind: 'result',
    title: `Made the workspace “${workspace.name}”`,
    body:
      move.items.length > 0
        ? `${things(move.items.length)} moved into it. You can undo this.`
        : 'It is empty for now. You can undo this.',
    priority: 'low',
    workspaceId: workspace.id,
  });
  return { kind: 'made', workspace, move, skipped };
}

/** Saves an offer for Avi to answer, and tells him in the Inbox. Returns false when the same one is already open. */
export async function makeOffer(
  deps: PlaceDeps,
  offer: { kind: WorkspaceOffer['kind']; workspace: Workspace; items: PlaceItem[] },
): Promise<WorkspaceOffer | null> {
  const { offer: saved, added } = await deps.placement.addOffer({
    kind: offer.kind,
    workspaceId: offer.workspace.id,
    workspaceName: offer.workspace.name,
    // Things in no workspace were in none (even one whose workspace was since deleted)
    items: offer.items.map(item => ({
      ...item.ref,
      title: item.title,
      fromWorkspaceId: offer.kind === 'wrong' ? item.workspaceId : null,
    })),
  });
  if (!added) return null;
  const n = offer.items.length;
  const lead =
    offer.kind === 'wrong'
      ? `${things(n)} may belong in ${offer.workspace.name}, not where ${n === 1 ? 'it is' : 'they are'} now.`
      : offer.kind === 'sheet'
        ? `${things(n)} in No workspace look like ${offer.workspace.name}.`
        : `These ${n} look like ${offer.workspace.name}.`;
  await deps.inbox.add({
    source: WORKSPACES_SOURCE,
    externalId: saved.id,
    kind: 'alert',
    title: `Move ${n === 1 ? 'it' : `these ${n}`} to ${offer.workspace.name}?`,
    body: [lead, ...offer.items.slice(0, 6).map(item => `- ${item.title}`)].join('\n'),
    priority: 'low',
    workspaceId: offer.workspace.id,
  });
  return saved;
}

/** Avi said yes to an offer: the things still where it found them move, as his own placing. */
export async function acceptOffer(
  deps: PlaceDeps,
  offerId: string,
  only?: PlaceRef[],
): Promise<{ moved: number; skipped: number; workspaceName: string; moveId: string | null }> {
  const offer = await deps.placement.getOffer(offerId);
  if (!offer || offer.status !== 'open') throw new Error('That offer has been answered already.');
  const workspace = (await deps.workspaces.list()).find(item => item.id === offer.workspaceId);
  if (!workspace) throw new Error(`The workspace “${offer.workspaceName}” is gone.`);
  const chosen = only ? new Set(only.map(keyOf)) : null;
  const items = offer.items.filter(item => !chosen || chosen.has(keyOf(item)));
  const { move, skipped } = await moveItems(deps, {
    refs: items,
    workspace,
    by: 'offer',
    setBy: 'avi',
    expectFrom: new Map(items.map(item => [keyOf(item), item.fromWorkspaceId])),
  });
  await deps.placement.resolveOffer(offerId, { status: 'moved', moveId: move?.id ?? null });
  // What Avi unticked he declined for this workspace
  const left = offer.items.filter(item => chosen && !chosen.has(keyOf(item)));
  if (left.length) await deps.placement.decline(left, workspace.id);
  await deps.inbox.close(WORKSPACES_SOURCE, offerId);
  return { moved: move?.items.length ?? 0, skipped, workspaceName: workspace.name, moveId: move?.id ?? null };
}

/** Avi said no: nothing moves, and the same things are never offered for that workspace again. */
export async function dismissOffer(deps: PlaceDeps, offerId: string): Promise<void> {
  await deps.placement.resolveOffer(offerId, { status: 'dismissed' });
  await deps.inbox.close(WORKSPACES_SOURCE, offerId);
}

const ORDER = { task: 0, thread: 1, meeting: 2, kb: 3 } as const;

/** What sits in no workspace, as the sheet lists it: tasks first, then chats, meetings and knowledge. */
export async function unplacedItems(deps: Pick<PlaceDeps, 'items' | 'workspaces'>): Promise<PlaceItem[]> {
  const known = await deps.workspaces.list();
  return (await deps.items.list())
    .filter(item => isUnplaced(item, known))
    .sort((a, b) => ORDER[a.ref.kind] - ORDER[b.ref.kind] || a.title.localeCompare(b.title))
    .slice(0, 300);
}
