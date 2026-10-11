import { threadStore, workspaceStore } from '@extension/storage';
import type { Workspace } from '@extension/storage';
import type { AgentContext } from '../agent/types';
import { createLogger } from '../log';

const logger = createLogger('Workspaces');

const PLATFORM_NAMES: Record<string, string> = {
  google: 'Google (Gmail, Meet, Calendar, Drive)',
  x: 'X (Twitter)',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  instagram: 'Instagram',
  slack: 'Slack',
  github: 'GitHub',
};

/** What the agent is told about the workspace a task belongs to. */
export function workspaceSection(workspace: Workspace): string {
  const accounts = Object.entries(workspace.accounts)
    .filter(([, account]) => account?.trim())
    .map(([platform, account]) => `- ${PLATFORM_NAMES[platform] ?? platform}: ${account!.trim()}`);
  return [
    `[Workspace: ${workspace.name}]`,
    "This task belongs to this workspace. Use only its context and its accounts; never bring in another workspace's people, facts or accounts.",
    workspace.about.trim() && `What the user says about it:\n${workspace.about.trim()}`,
    accounts.length
      ? `Act as these accounts:\n${accounts.join('\n')}\nBefore acting on one of these sites, check which account is signed in. If it is another one, switch to this workspace's account first (the account-switching skill says how). If the account has no session, stop and ask the user to sign in.`
      : 'No accounts are set for this workspace: before posting, sending or creating anything, say which account is signed in and ask the user if it is the right one.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The workspace section for a task's step, or nothing when its chat is in no workspace. */
export async function workspaceSectionFor(context: AgentContext): Promise<string> {
  try {
    const thread = await threadStore.get(context.taskId);
    const workspace = await workspaceStore.get(thread?.workspaceId);
    return workspace ? `\n${workspaceSection(workspace)}\n` : '';
  } catch (error) {
    logger.error('Could not load the workspace', error);
    return '';
  }
}
