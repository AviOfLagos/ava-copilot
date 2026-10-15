import {
  aboutYouStore,
  assistantNameOf,
  coreIdentityStore,
  effectiveCore,
  EMPTY_ABOUT_YOU,
  generalSettingsStore,
  workspaceStore,
} from '@extension/storage';
import type { IdentityContext } from './prompt';

/**
 * Loads what the identity prompts need for a chat in `workspaceId` (or none). Never throws: a store that cannot be
 * read gives the defaults, so a prompt always has the core.
 */
export async function loadIdentityContext(workspaceId: string | null | undefined): Promise<IdentityContext> {
  const [settings, core, about, workspaces] = await Promise.all([
    generalSettingsStore.getSettings().catch(() => null),
    coreIdentityStore.getCore().catch(() => null),
    aboutYouStore.getState().catch(() => EMPTY_ABOUT_YOU),
    workspaceStore.list().catch(() => []),
  ]);
  return {
    name: assistantNameOf(settings?.assistantName),
    core: effectiveCore(core),
    facts: about.facts.filter(fact => fact.status === 'active'),
    goals: about.goals,
    insights: about.insights,
    workspaceId: workspaceId ?? null,
    workspaceNames: Object.fromEntries(workspaces.map(workspace => [workspace.id, workspace.name])),
  };
}
