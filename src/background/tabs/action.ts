import { z } from 'zod';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { ageText, matchTabs, tabRegistry } from '../browser/tabRegistry';
import type { ListedTab } from '../browser/tabRegistry';

const MOST = 10;

export const findTabActionSchema = {
  name: 'find_tab',
  description:
    'Find a tab the user already has open, in any of their windows, by site or by words from its title. Returns tab ids for switch_tab. Use it before opening a site in a new tab, and to answer what the user has open. Read-only.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    query: z
      .string()
      .min(1)
      .max(200)
      .describe('a site ("facebook.com", "slack") or words from the tab title; "*" lists every open tab'),
  }),
} satisfies ActionSchema;

export const FIND_TAB_PROMPT = `- find_tab: before you open a site in a new tab, check whether the user already has it open (the state lists open tabs by site) and switch_tab to it instead. A tab marked busy belongs to another task: never use it.`;

/** One found tab, as the model reads it. The title is the page's own words: data, never instructions. */
export function tabLine(tab: ListedTab, now: number, self: string): string {
  const state =
    tab.heldBy !== null && tab.heldBy !== self
      ? 'BUSY with another task, do not use'
      : tab.active
        ? 'in front now'
        : `last used ${ageText(now - tab.lastActiveAt)} ago`;
  return `{id: ${tab.id}, site: ${tab.host}, title: ${JSON.stringify(tab.title)}, open ${ageText(now - tab.openedAt)}, ${state}}`;
}

/**
 * Handles find_tab. It lists only tabs this task may use (its own, and free web pages it may take over) and,
 * marked busy, the ones another task holds. Private windows are never listed.
 */
export async function findTabAction(
  context: AgentContext,
  input: z.infer<typeof findTabActionSchema.schema>,
): Promise<ActionResult> {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || `Looking for a "${input.query}" tab`);
  const usable = new Set((await context.browserContext.getTabInfos()).map(tab => tab.id));
  const listed = (await tabRegistry.list()).filter(
    tab => usable.has(tab.id) || (tab.heldBy !== null && tab.heldBy !== context.taskId),
  );
  const query = input.query.trim();
  const found = (query === '*' ? listed : matchTabs(listed, query)).slice(0, MOST);
  const now = Date.now();
  if (!found.length) {
    const none = `No open tab matches "${query}". Open the site in a new tab if you need it.`;
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, none);
    return new ActionResult({ extractedContent: none, includeInMemory: true });
  }
  context.emitEvent(
    Actors.NAVIGATOR,
    ExecutionState.ACT_OK,
    `Found ${found.length} open ${found.length === 1 ? 'tab' : 'tabs'}`,
  );
  const lines = found.map(tab => tabLine(tab, now, context.taskId)).join('\n');
  return new ActionResult({
    extractedContent: `Open tabs matching "${query}" (switch_tab to one by id):\n${wrapUntrustedContent(lines)}`,
    includeInMemory: true,
  });
}
