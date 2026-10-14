import { routeWorkspace } from '@extension/storage';
import type { Workspace } from '@extension/storage';
import type { ImportedConversation } from './tools';

export type RouteReason = 'mapped' | 'folder' | 'words' | 'none';

/** A project folder as one key: trimmed, without a trailing slash. */
export function projectKey(project: string | null | undefined): string | null {
  const key = project?.trim().replace(/\/+$/, '');
  return key || null;
}

// Folder names that say nothing about a workspace
const PLAIN_FOLDERS = new Set(['users', 'home', 'desktop', 'documents', 'downloads', 'projects', 'code', 'src', 'dev']);

/** The words of a project's path that can name a workspace: its folders, without the common ones. */
function folderWords(project: string): string {
  return (
    project
      // The home folder's name is the user's, not a workspace's
      .replace(/^\/(Users|home)\/[^/]+/i, '')
      .split('/')
      .filter(part => part && !PLAIN_FOLDERS.has(part.toLowerCase()) && !/^\d+$/.test(part))
      .join(' ')
      .replace(/[-_.]+/g, ' ')
  );
}

/** The mapping that covers a project: its own, else the nearest parent folder's. */
export function mappedWorkspace(
  project: string | null,
  mappings: Record<string, string | null>,
): { found: boolean; workspaceId: string | null } {
  let key = projectKey(project);
  while (key) {
    if (key in mappings) return { found: true, workspaceId: mappings[key] };
    const cut = key.lastIndexOf('/');
    key = cut > 0 ? key.slice(0, cut) : null;
  }
  return { found: false, workspaceId: null };
}

/**
 * Which workspace an imported conversation belongs to: the user's mapping of its project folder (or a
 * parent folder) first, then a workspace its folder names (`…/Nexprove/desk` is Nexprove's), then one
 * its title and first request name. Only when exactly one matches; otherwise none, and it stays general.
 */
export function routeConversation(
  conversation: Pick<ImportedConversation, 'project' | 'title' | 'turns'>,
  workspaces: Workspace[],
  mappings: Record<string, string | null>,
): { workspaceId: string | null; reason: RouteReason } {
  const mapped = mappedWorkspace(conversation.project, mappings);
  if (mapped.found) {
    const exists = mapped.workspaceId === null || workspaces.some(item => item.id === mapped.workspaceId);
    if (exists) return { workspaceId: mapped.workspaceId, reason: mapped.workspaceId ? 'mapped' : 'none' };
  }
  const project = projectKey(conversation.project);
  if (project) {
    const byFolder = routeWorkspace(folderWords(project), workspaces);
    if (byFolder) return { workspaceId: byFolder.id, reason: 'folder' };
  }
  const firstAsk = conversation.turns.find(turn => turn.role === 'user')?.text.slice(0, 600) ?? '';
  const byWords = routeWorkspace(`${conversation.title}\n${firstAsk}`, workspaces);
  if (byWords) return { workspaceId: byWords.id, reason: 'words' };
  return { workspaceId: null, reason: 'none' };
}
