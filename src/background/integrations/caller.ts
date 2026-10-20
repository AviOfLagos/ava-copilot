import { threadStore } from '@extension/storage';
import type { ThreadRecord } from '@extension/storage';
import type { AgentContext } from '../agent/types';
import type { CallScope } from './service';

// Chats nobody is watching: a tool that asks first cannot ask there. From WhatsApp the user is away from the
// computer, so nothing that opens a sign-in for him is set up from there
const UNATTENDED: ReadonlySet<NonNullable<ThreadRecord['origin']>> = new Set([
  'workflow',
  'agent',
  'brief',
  'whatsapp',
]);

/** Where a task runs: its chat's workspace, the agent it runs as, and whether the user started it. */
export async function callerOf(
  context: Pick<AgentContext, 'taskId'>,
): Promise<{ scope: CallScope; attended: boolean }> {
  const thread = await threadStore.get(context.taskId).catch(() => undefined);
  return {
    scope: { workspaceId: thread?.workspaceId ?? null, agentId: thread?.agentId ?? null },
    attended: !(thread?.origin && UNATTENDED.has(thread.origin)),
  };
}
