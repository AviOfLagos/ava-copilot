import type { ChatModel } from '../llm/types';
import { createRoleModel } from '../models/roles';
import { resolveModels } from '../threads/factory';

/**
 * The model the Inbox summarises with: cheap, tool-less, "fast". Same fallback shape as
 * `workflows/models.ts`'s `workflowModel`, so a fresh install with no catalog yet still gets a usable
 * model from the agent settings instead of failing the whole summary.
 */
export async function summarizerModel(sessionId: string): Promise<ChatModel> {
  try {
    return (await createRoleModel('fast', { sessionId, notify: () => {} })).chatModel;
  } catch {
    const { navigator } = await resolveModels(null, { sessionId, notify: () => {} });
    return navigator;
  }
}
