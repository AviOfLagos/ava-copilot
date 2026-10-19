// Private and team memory for agents: the agent's share_with_team action, and the user's moves between an
// agent's private memory and the team's (or deleting an item) from the panel or any extension page.
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { Action } from '../agent/actions/builder';
import { createLogger } from '../log';
import { dispatchCommand, registerAgentAction, registerCommand } from '../registry';
import { services } from '../registry/services';
import { SHARE_WITH_TEAM_PROMPT, shareWithTeamAction, shareWithTeamActionSchema } from './action';

const logger = createLogger('Memory');

const itemId = z.string().min(1).max(4000);

function command<S extends z.ZodType>(type: string, schema: S, run: (input: z.infer<S>) => Promise<unknown>): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = await run(input);
      context.reply({ type: 'memory_ok', requestId: context.requestId, result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

// The user's click: only pages of the extension send these, never an agent
command('memory_set_scope', z.object({ itemId, scope: z.enum(['private', 'team']) }), input =>
  services().kb.setScope(input.itemId, input.scope),
);
command('memory_delete', z.object({ itemId }), input => services().kb.remove(input.itemId));

registerAgentAction({
  prompt: SHARE_WITH_TEAM_PROMPT,
  create: context =>
    new Action(
      (input: z.infer<typeof shareWithTeamActionSchema.schema>) => shareWithTeamAction(context, input),
      shareWithTeamActionSchema,
    ),
});

// Extension pages (the Knowledge base, an agent's page, the full-page Settings) send these as one-off messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('memory_')) return;
  const requestId = typeof message.requestId === 'string' ? message.requestId : null;
  void dispatchCommand(message, { reply: sendResponse, requestId }).then(handled => {
    if (!handled) sendResponse({ type: 'error', requestId, error: 'Unknown request.' });
  });
  return true;
});
