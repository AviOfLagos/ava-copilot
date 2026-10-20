import { threadStore } from '@extension/storage';
import type { AgentContext } from '../agent/types';
import { userAtComputer } from '../gate/origins';
import type { CallScope } from './service';

/** Where a task runs: its chat's workspace, the agent it runs as, and whether the user started it. */
export async function callerOf(
  context: Pick<AgentContext, 'taskId'>,
): Promise<{ scope: CallScope; attended: boolean }> {
  const thread = await threadStore.get(context.taskId).catch(() => undefined);
  return {
    scope: { workspaceId: thread?.workspaceId ?? null, agentId: thread?.agentId ?? null },
    // Adding a connector opens a sign-in: only for the user at the computer (../gate/origins)
    attended: userAtComputer(thread) || !thread,
  };
}
