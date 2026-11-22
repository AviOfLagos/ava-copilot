import { looselyMatching } from './rules';
import { makeOffer, makeWorkspace, things, unplacedItems } from './place';
import type { PlaceDeps } from './place';

// `workspace_create` (docs/pm-desk.md, Part 3): the agent action and the voice tool share this. The workspace is made
// at once and said back; the things in "No workspace" that fit it are offered in one sheet, never moved by this.

export interface CreateScope {
  // Where the words come from: "Ava, create a workspace called Lead Engine" by voice, or a typed chat
  by: 'voice' | 'agent';
  // What Avi himself said or typed in this conversation: never a page, a call or a message from someone else (rule 2)
  userWords: string;
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
const tokens = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Whether Avi's own words hold the name: a workspace is only made for a name he said. Whole words, in a row, through
 * case, spaces and punctuation ("lead-engine" is "Lead Engine"): a piece of a longer word ("sum" in "summarise") is not
 * a name he said, and nor is a one-letter name.
 */
export const saidByUser = (name: string, userWords: string): boolean => {
  const wanted = squash(name);
  if (wanted.length < 2) return false;
  const said = tokens(userWords);
  for (let start = 0; start < said.length; start++) {
    let joined = '';
    for (let end = start; end < said.length && joined.length < wanted.length; end++) {
      joined += said[end];
      if (joined === wanted) return true;
    }
  }
  return false;
};

export async function workspaceCreate(
  deps: PlaceDeps,
  scope: CreateScope,
  input: { name: string; keywords?: string[] },
): Promise<string> {
  const name = input.name.trim();
  if (!name) return 'A workspace needs a name. Ask the user what to call it.';
  if (!saidByUser(name, scope.userWords)) {
    return 'No workspace was made: the name did not come from the user. Ask them what they want it called.';
  }
  // Keywords make rules that move things later, so they too must be words Avi said, not ones a page or a call gave
  const keywords = (input.keywords ?? []).filter(word => saidByUser(word, scope.userWords));
  const made = await makeWorkspace(deps, { name, keywords, by: scope.by });
  if (made.kind === 'exists') return `A workspace called “${made.workspace.name}” already exists, so nothing was made.`;
  const { workspace } = made;
  const all = await deps.workspaces.list();
  const matches = looselyMatching(await unplacedItems(deps), workspace, all);
  let said = `Made the workspace “${workspace.name}”. It can be undone for 30 seconds in the panel, and later from the Inbox.`;
  if (matches.length > 0) {
    await makeOffer(deps, { kind: 'sheet', workspace, items: matches });
    said += ` ${things(matches.length)} in No workspace look like it: the panel now shows them, to move in one confirm. Say that, and do not move them yourself.`;
  }
  return said;
}
