import { declinedKey, refKey } from '@extension/storage';
import type { Person, PlaceRef, Workspace, WorkspaceMove } from '@extension/storage';
import { checkGuesses } from './suggest';
import type { SuggestModel } from './suggest';
import { makeOffer, moveItems } from './place';
import type { PlaceDeps } from './place';
import { planSort } from './rules';
import type { PlaceItem } from './rules';

// The sorting pass (docs/pm-desk.md, Part 3): things in no workspace that two or more rules point at one workspace are
// moved and told in the next brief; things only a model can place, and things in the wrong workspace, are offered in
// the Inbox. Nothing Avi placed is ever touched, and nothing here runs a command a page or a call can give.

const DAY = 24 * 60 * 60 * 1000;
// A workspace made by voice shows its sheet first; rules leave those things alone this long
const SHEET_HOLDS = 3 * DAY;
// A thing the model has already guessed about is not asked about again for this long
const GUESS_AGAIN = 14 * DAY;
const GUESS_BATCH = 30;

export interface SortDeps extends PlaceDeps {
  people: { list(): Promise<Person[]> };
  // Null: no model guesses (none set up, the day's budget spent, or a test)
  model?: SuggestModel | null;
}

export interface SortResult {
  moved: WorkspaceMove[];
  offered: number;
}

export async function sortUnplaced(deps: SortDeps, options: { guess?: boolean } = {}): Promise<SortResult> {
  const now = (deps.now ?? Date.now)();
  const [workspaces, people, items, state] = await Promise.all([
    deps.workspaces.list(),
    deps.people.list(),
    deps.items.list(),
    deps.placement.state(),
  ]);
  if (workspaces.length === 0) return { moved: [], offered: 0 };
  const reserved = new Set<string>();
  for (const offer of state.offers) {
    if (offer.status !== 'open') continue;
    if (offer.kind === 'sheet' && now - offer.createdAt > SHEET_HOLDS) continue;
    for (const item of offer.items) reserved.add(refKey(item));
  }
  const plan = planSort({ items, workspaces, people, declined: new Set(state.declined), reserved });

  const moved: WorkspaceMove[] = [];
  for (const group of plan.moves) {
    const refs = group.items.map(item => item.ref);
    const { move } = await moveItems(deps, {
      refs,
      workspace: group.workspace,
      by: 'rule',
      setBy: 'rule',
      expectFrom: new Map(refs.map(ref => [refKey(ref), null])),
    });
    if (move) moved.push(move);
  }

  let offered = 0;
  for (const group of plan.wrong) {
    if (await makeOffer(deps, { kind: 'wrong', workspace: group.workspace, items: group.items })) offered++;
  }

  if (options.guess !== false && deps.model && plan.unclear.length > 0) {
    offered += await guessAndOffer(deps, plan.unclear, workspaces, state.guessed, now);
  }
  return { moved, offered };
}

async function guessAndOffer(
  deps: SortDeps,
  unclear: PlaceItem[],
  workspaces: Workspace[],
  guessed: Record<string, number>,
  now: number,
): Promise<number> {
  const pool = unclear.filter(item => now - (guessed[refKey(item.ref)] ?? 0) > GUESS_AGAIN).slice(0, GUESS_BATCH);
  if (pool.length < 2) return 0;
  const lines = pool.map((item, index) => ({ n: index + 1, text: item.title }));
  const answers = await deps
    .model!.guess(
      lines,
      workspaces.map(workspace => ({
        id: workspace.id,
        name: workspace.name,
        about: workspace.about,
        keywords: workspace.keywords,
      })),
    )
    .catch(() => null);
  // A failed answer is not recorded: the same things are asked about again next time
  if (!answers) return 0;
  await deps.placement.markGuessed(pool.map(item => item.ref as PlaceRef));
  const picked = checkGuesses(
    answers,
    lines.map(line => line.n),
    workspaces,
  );
  const byWorkspace = new Map<string, PlaceItem[]>();
  for (const [n, workspaceId] of picked) {
    byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), pool[n - 1]]);
  }
  let offered = 0;
  const declined = new Set((await deps.placement.state()).declined);
  for (const [workspaceId, group] of byWorkspace) {
    const items = group.filter(item => !declined.has(declinedKey(item.ref, workspaceId)));
    // One guess is too thin to bother Avi with
    if (items.length < 2) continue;
    const workspace = workspaces.find(item => item.id === workspaceId)!;
    if (await makeOffer(deps, { kind: 'guess', workspace, items })) offered++;
  }
  return offered;
}
