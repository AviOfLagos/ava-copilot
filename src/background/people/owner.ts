import { workspaceStore } from '@extension/storage';

/**
 * The owner's own addresses: the Google account of each workspace. The owner is on every invite and every call,
 * and is never a person to ask about.
 */
export async function ownerEmails(): Promise<Set<string>> {
  const workspaces = await workspaceStore.list().catch(() => []);
  return new Set(
    workspaces
      .map(workspace => workspace.accounts.google?.trim().toLowerCase())
      .filter((email): email is string => !!email),
  );
}

// How a tool shows the owner himself, in the languages Meet speaks: "You", "Você", "(You)"
const SELF = /^(you|me|myself|i|você|eu|tú|yo|vous|moi|du|ich|tu|io|您|你|我|あなた|私|나)$/i;

/** Whether a name is how a tool or a note names the owner himself ("You", "me"). */
export const isSelfName = (name: string) => SELF.test(name.trim());

// Owners a meeting note gives that are nobody in particular
const NOBODY = /^(we|us|everyone|everybody|all|team|the team|tbd|tbc|unassigned|someone|anyone|n\/a|none|-)$/i;

export const isNobody = (name: string) => NOBODY.test(name.trim());
