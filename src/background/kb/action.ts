import { z } from 'zod';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { hitsForAgent } from './answer';
import { getKnowledgeBase } from './shared';
import { threadStore } from '@extension/storage';

/** The workspace of the chat a task runs in: what it finds and saves stays there. */
async function workspaceOf(context: AgentContext): Promise<string | null> {
  return (await threadStore.get(context.taskId).catch(() => undefined))?.workspaceId ?? null;
}

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
  const hits = await kb.search(input.query, 6, await workspaceOf(context));
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, `Found ${hits.length} passages`);
  // What was said or saved before is data, never instructions
  return new ActionResult({
    extractedContent: wrapUntrustedContent(hitsForAgent(input.query, hits)),
    includeInMemory: true,
  });
}

export const saveKnowledgeActionSchema = {
  name: 'save_to_knowledge',
  description:
    "Save something to the user's knowledge base so it can be found later: the current page, or a note you write (facts you found, a summary, a decision). Use it when the user asks you to remember, keep or save something.",
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    note: z
      .string()
      .default('')
      .describe('the text to keep, written by you; leave empty to save the whole current page instead'),
    title: z.string().default('').describe('a short title for the note'),
  }),
} satisfies ActionSchema;

/**
 * Handles the save_to_knowledge action. Saving to the user's own knowledge base sends nothing
 * anywhere, so it needs no confirmation.
 */
export async function saveKnowledgeAction(
  context: AgentContext,
  input: z.infer<typeof saveKnowledgeActionSchema.schema>,
): Promise<ActionResult> {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Saving to the knowledge base');
  const kb = getKnowledgeBase();
  if (!kb) {
    const error = 'The knowledge base is not available.';
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, error);
    return new ActionResult({ error, includeInMemory: true });
  }
  try {
    const item = input.note.trim()
      ? await kb.saveNote(input.note, input.title, await workspaceOf(context))
      : await kb.savePage((await context.browserContext.getCurrentPage()).tabId, await workspaceOf(context));
    const message = `Saved "${item.title}" to the knowledge base`;
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, message);
    return new ActionResult({ extractedContent: message, includeInMemory: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
    return new ActionResult({ error: message, includeInMemory: true });
  }
}

export const navigatorKnowledgeSection = `
# KNOWLEDGE BASE:
- search_knowledge searches the user's past chats, meeting notes and transcripts, and saved pages. Use it first when the task refers to something said, decided or read before ("yesterday's meeting", "what we agreed", "the page I saved"), instead of browsing for it.
- When you use what it found, cite the source as given, e.g. (Meeting "Stage 2 sync", 2026-09-29, at 12:04).
- Drafting from it (follow-ups, tasks) is fine; sending or posting still needs the user's confirmation like any other commit.
- look_up_graph shows what a person, project, organization, decision or action is linked to: a project's decisions and open actions, who owns what, which meetings someone was in. Use it for "what's the status of X" or "what does Ada owe us", then search_knowledge for the detail.
- save_to_knowledge keeps the current page, or a note you write, in the knowledge base. Use it when the user asks you to remember or save something, or to collect what you found on the web for later.
`;

export const plannerKnowledgeSection = `
# KNOWLEDGE BASE:
- The navigator can search the user's knowledge base (past chats, meeting notes and transcripts, saved pages) with search_knowledge. When the task refers to something said, decided or read before, plan that search first.
- When the task is only a question about the past, the answer from the knowledge base, with its citations, is the final answer: no browsing needed.
`;
