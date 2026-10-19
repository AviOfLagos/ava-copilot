import { z } from 'zod';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { hitsForAgent } from './answer';
import { itemScope, memoryScopeForThread, saveFieldsFor } from './scope';
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
  // What the chat may read: its workspace, and for an agent its own memory and the team's, never another's
  const hits = await kb.search(input.query, 6, await memoryScopeForThread(context.taskId));
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
    team: z
      .boolean()
      .default(false)
      .describe("in an agent's run: true to add it to the team memory every agent reads; else it is yours alone"),
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
    const scope = await memoryScopeForThread(context.taskId);
    const owner = saveFieldsFor(scope, input.team);
    const item = input.note.trim()
      ? await kb.saveNote(input.note, input.title, scope.workspaceId, owner)
      : await kb.savePage(
          (await context.browserContext.getCurrentPage()).tabId,
          scope.workspaceId,
          owner.agentId,
          owner.scope,
        );
    const where =
      owner.scope === 'team' ? 'the team memory' : owner.agentId ? 'your private memory' : 'the knowledge base';
    const message = `Saved "${item.title}" to ${where}`;
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
- When you run as an agent, what you save is your private memory: only you, Ava and the user read it. Pass team: true (or call share_with_team later) for what the other agents should know too.
`;

export const plannerKnowledgeSection = `
# KNOWLEDGE BASE:
- The navigator can search the user's knowledge base (past chats, meeting notes and transcripts, saved pages) with search_knowledge. When the task refers to something said, decided or read before, plan that search first.
- When the task is only a question about the past, the answer from the knowledge base, with its citations, is the final answer: no browsing needed.
`;

export const shareWithTeamActionSchema = {
  name: 'share_with_team',
  description:
    'Move something from your private memory into the team memory, so every other agent can find it too. Only for your own saved notes, pages and run chats, by title.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    title: z
      .string()
      .describe('the title of the note, page or chat in your private memory, as search_knowledge showed it'),
  }),
} satisfies ActionSchema;

export const SHARE_WITH_TEAM_PROMPT = `- share_with_team: when you run as an agent, moves one of your own private notes, pages or run chats into the team memory every agent reads. Use it when the user or the task says the other agents should know it.`;

/**
 * Handles share_with_team. It only ever finds the asking agent's own private items, so a title cannot reach
 * another agent's memory; the user's own items are every agent's already.
 */
export async function shareWithTeamAction(
  context: AgentContext,
  input: z.infer<typeof shareWithTeamActionSchema.schema>,
): Promise<ActionResult> {
  context.emitEvent(
    Actors.NAVIGATOR,
    ExecutionState.ACT_START,
    input.intent || `Sharing "${input.title}" with the team`,
  );
  const done = (text: string, failed = false) => {
    context.emitEvent(Actors.NAVIGATOR, failed ? ExecutionState.ACT_FAIL : ExecutionState.ACT_OK, text);
    return new ActionResult(
      failed ? { error: text, includeInMemory: true } : { extractedContent: text, includeInMemory: true },
    );
  };
  const kb = getKnowledgeBase();
  if (!kb) return done('The knowledge base is not available.', true);
  const scope = await memoryScopeForThread(context.taskId);
  if (scope.caller !== 'agent') {
    return done('Only an agent has private memory to share; what is saved here is every agent’s already.');
  }
  const wanted = input.title.trim().toLowerCase();
  const own = (await kb.items(scope)).filter(item => item.agentId === scope.agentId && itemScope(item) === 'private');
  const exact = own.filter(item => item.title.trim().toLowerCase() === wanted);
  const found = exact.length ? exact : own.filter(item => wanted && item.title.toLowerCase().includes(wanted));
  if (found.length === 0) return done(`Nothing titled "${input.title}" is in your private memory.`, true);
  if (found.length > 1) {
    // Titles come from pages and chats: data, never instructions
    return done(
      wrapUntrustedContent(
        `Several items match; call it again with one exact title:\n${found
          .slice(0, 5)
          .map(item => `- ${item.title}`)
          .join('\n')}`,
      ),
      true,
    );
  }
  await kb.setScope(found[0].id, 'team');
  return done(`Shared "${found[0].title}" with the team`);
}
