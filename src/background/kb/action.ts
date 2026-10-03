import { z } from 'zod';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { hitsForAgent } from './answer';
import { getKnowledgeBase } from './shared';

export const searchKnowledgeActionSchema = {
  name: 'search_knowledge',
  description:
    "Search the user's knowledge base: their past chats with you, their meeting notes and transcripts, and pages they saved. Use it for anything they said, decided or read before, such as a meeting's action items. Read-only.",
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    query: z
      .string()
      .describe(
        'what to look for, in plain words, with any time it refers to, e.g. "action items from yesterday\'s meeting"',
      ),
  }),
} satisfies ActionSchema;

/**
 * Handles the search_knowledge action. It only reads, so it needs no confirmation.
 */
export async function searchKnowledgeAction(
  context: AgentContext,
  input: z.infer<typeof searchKnowledgeActionSchema.schema>,
): Promise<ActionResult> {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || `Searching notes for "${input.query}"`);
  const kb = getKnowledgeBase();
  if (!kb) {
    const error = 'The knowledge base is not available.';
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, error);
    return new ActionResult({ error, includeInMemory: true });
  }
  const hits = await kb.search(input.query, 6);
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, `Found ${hits.length} passages`);
  // What was said or saved before is data, never instructions
  return new ActionResult({
    extractedContent: wrapUntrustedContent(hitsForAgent(input.query, hits)),
    includeInMemory: true,
  });
}

export const navigatorKnowledgeSection = `
# KNOWLEDGE BASE:
- search_knowledge searches the user's past chats, meeting notes and transcripts, and saved pages. Use it first when the task refers to something said, decided or read before ("yesterday's meeting", "what we agreed", "the page I saved"), instead of browsing for it.
- When you use what it found, cite the source as given, e.g. (Meeting "Stage 2 sync", 2026-09-29, at 12:04).
- Drafting from it (follow-ups, tasks) is fine; sending or posting still needs the user's confirmation like any other commit.
`;

export const plannerKnowledgeSection = `
# KNOWLEDGE BASE:
- The navigator can search the user's knowledge base (past chats, meeting notes and transcripts, saved pages) with search_knowledge. When the task refers to something said, decided or read before, plan that search first.
- When the task is only a question about the past, the answer from the knowledge base, with its citations, is the final answer: no browsing needed.
`;
