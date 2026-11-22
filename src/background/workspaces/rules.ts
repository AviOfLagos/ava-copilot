import { declinedKey, matchWorkspaces, nameKey, refKey } from '@extension/storage';
import type { PlaceRef, Person, Workspace, WorkspaceSetBy } from '@extension/storage';

// Sorting by rule (docs/pm-desk.md, Part 3). Plain code, no model: what a thing says, who is in it, and which account
// it came through decide, and only when exactly one workspace fits. Nothing here writes anything.

/** One thing that can sit in a workspace (a task, a chat, a meeting, a knowledge item), as the rules read it. */
export interface PlaceItem {
  ref: PlaceRef;
  // How it is named to Avi, one plain line
  title: string;
  // The words the rules read: what it says, never what a model wrote about it
  text: string;
  // People it names (a task's owner, a call's roster), as written
  names: string[];
  workspaceId: string | null;
  // Who put it there; null when no one recorded it, which counts as not Avi's but never as a rule's or Ava's either
  setBy: WorkspaceSetBy | null;
}

/** The person a written name is, when exactly one person has it as their name or an alias. */
export function personNamed(name: string, people: Person[]): Person | null {
  const key = nameKey(name);
  if (!key) return null;
  const found = people.filter(person => person.nameKey === key || person.aliasKeys.includes(key));
  return found.length === 1 ? found[0] : null;
}

/**
 * The workspace most of a call's known participants belong to: more than half of the people Ava knows by name.
 * Someone in two workspaces counts for both, so a tie never picks one. People she does not know are left out.
 */
export function workspaceByParticipants(names: string[], people: Person[], workspaces: Workspace[]): Workspace | null {
  const known = new Map<string, Person>();
  for (const name of names) {
    const person = personNamed(name, people);
    if (person) known.set(person.id, person);
  }
  if (known.size === 0) return null;
  const counts = new Map<string, number>();
  for (const person of known.values()) {
    for (const id of new Set(person.workspaceIds)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const winners = workspaces.filter(workspace => (counts.get(workspace.id) ?? 0) * 2 > known.size);
  return winners.length === 1 ? winners[0] : null;
}

/** The workspaces a person points at on their own: only when they belong to exactly one. */
function personEvidence(names: string[], people: Person[], workspaces: Workspace[]): string[] {
  const ids: string[] = [];
  for (const name of names) {
    const person = personNamed(name, people);
    const only = person?.workspaceIds.length === 1 ? person.workspaceIds[0] : null;
    if (only && workspaces.some(workspace => workspace.id === only)) ids.push(only);
  }
  return ids;
}

/**
 * Every workspace a thing points at by rule: its words (a workspace's name, keywords or Google domain), the people in
 * it, and for a meeting, where most of its known participants belong. Two or more means it is unclear: no rule moves it.
 */
export function evidenceFor(item: PlaceItem, workspaces: Workspace[], people: Person[]): string[] {
  const found = new Set(matchWorkspaces(item.text, workspaces).map(workspace => workspace.id));
  if (item.ref.kind === 'meeting') {
    const byPeople = workspaceByParticipants(item.names, people, workspaces);
    if (byPeople) found.add(byPeople.id);
  } else {
    for (const id of personEvidence(item.names, people, workspaces)) found.add(id);
  }
  return [...found];
}

/** Whether a thing sits in no workspace now (a workspace since deleted counts as none). */
export const isUnplaced = (item: PlaceItem, workspaces: Workspace[]): boolean =>
  !item.workspaceId || !workspaces.some(workspace => workspace.id === item.workspaceId);

/** Anything Avi placed himself is never moved for him. */
export const isAvis = (item: PlaceItem): boolean => item.setBy === 'avi';

export interface SortInput {
  items: PlaceItem[];
  workspaces: Workspace[];
  people: Person[];
  // "kind:id>workspaceId" pairs Avi turned down
  declined: ReadonlySet<string>;
  // "kind:id" of things already in an offer that waits for Avi
  reserved: ReadonlySet<string>;
}

export interface Group {
  workspace: Workspace;
  items: PlaceItem[];
}

export interface SortPlan {
  // Things in no workspace that fit exactly one: moved when two or more fit the same one
  moves: Group[];
  // Things a rule or Ava placed that fit exactly one other workspace and not their own: offered, never moved
  wrong: Group[];
  // Things in no workspace that no rule points at: only a model can guess where they go (offered, never moved)
  unclear: PlaceItem[];
}

const MOVE_AT_LEAST = 2;

function group(entries: { workspace: Workspace; item: PlaceItem }[]): Group[] {
  const byWorkspace = new Map<string, Group>();
  for (const { workspace, item } of entries) {
    const current = byWorkspace.get(workspace.id) ?? { workspace, items: [] };
    current.items.push(item);
    byWorkspace.set(workspace.id, current);
  }
  return [...byWorkspace.values()];
}

export function planSort(input: SortInput): SortPlan {
  const { workspaces, people, declined, reserved } = input;
  const unplaced: { workspace: Workspace; item: PlaceItem }[] = [];
  const wrong: { workspace: Workspace; item: PlaceItem }[] = [];
  const unclear: PlaceItem[] = [];
  for (const item of input.items) {
    if (reserved.has(refKey(item.ref))) continue;
    const fits = evidenceFor(item, workspaces, people);
    if (isUnplaced(item, workspaces)) {
      if (isAvis(item)) continue;
      if (fits.length === 0) unclear.push(item);
      if (fits.length !== 1 || declined.has(declinedKey(item.ref, fits[0]))) continue;
      unplaced.push({ workspace: workspaces.find(workspace => workspace.id === fits[0])!, item });
    } else if (item.setBy === 'rule' || item.setBy === 'ava') {
      // Offered only when its own workspace does not fit it at all and exactly one other does
      if (fits.length !== 1 || fits[0] === item.workspaceId) continue;
      if (declined.has(declinedKey(item.ref, fits[0]))) continue;
      wrong.push({ workspace: workspaces.find(workspace => workspace.id === fits[0])!, item });
    }
  }
  return {
    moves: group(unplaced).filter(entry => entry.items.length >= MOVE_AT_LEAST),
    wrong: group(wrong),
    unclear,
  };
}

// Words too common to say what a thing is about
const COMMON = new Set(
  (
    'the and for with from that this they them their there then than are was were has have had not but you your our ' +
    'task tasks meeting call notes note chat about into over under what when where which while will would should ' +
    'could can send make follow review update check email call plan prepare share'
  ).split(' '),
);

/** The words of a workspace's name that could match a thing loosely: used only to offer a list, never to move. */
export function nameWords(name: string): string[] {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 4 && !COMMON.has(word));
  return [...new Set(words)];
}

/** Things in no workspace that mention a new workspace's name or one of its words: offered for one confirm, not moved. */
export function looselyMatching(items: PlaceItem[], workspace: Pick<Workspace, 'name' | 'keywords'>, all: Workspace[]) {
  const phrases = [workspace.name, ...workspace.keywords, ...nameWords(workspace.name)].filter(
    phrase => phrase.trim().length >= 3,
  );
  const probe = [{ id: 'probe', name: phrases[0], keywords: phrases.slice(1), about: '', accounts: {}, createdAt: 0 }];
  return items.filter(
    item => isUnplaced(item, all) && !isAvis(item) && matchWorkspaces(item.text, probe as Workspace[]).length > 0,
  );
}
