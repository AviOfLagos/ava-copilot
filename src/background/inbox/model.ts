import type { ChatModel } from '../llm/types';
import { lightModel } from '../models/light';
import { resolveModels } from '../threads/factory';

/**
 * The model the Inbox summarises with: cheap, tool-less, "fast". Same fallback shape as
 * `workflows/models.ts`'s `workflowModel`, so a fresh install with no catalog yet still gets a usable
 * model from the agent settings instead of failing the whole summary.
 */
export async function summarizerModel(sessionId: string): Promise<ChatModel> {
  // Light work: a running local model first when the user prefers it, else the cloud's fast model
  const scope = { sessionId, notify: () => {} };
  return (await lightModel('inbox', scope, async () => (await resolveModels(null, scope)).navigator)).chatModel;
}
