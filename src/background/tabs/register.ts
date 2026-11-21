// Ava knows every open tab: the registry follows the browser's tab events from the background's first tick, and
// the agent gets find_tab. Which task holds a tab, and which window is the agents' own, are asked when needed.
import type { z } from 'zod';
import { Action } from '../agent/actions/builder';
import { agentWindow } from '../agents/instance';
import { tabRegistry } from '../browser/tabRegistry';
import { registerAgentAction } from '../registry';
import { services } from '../registry/services';
import { FIND_TAB_PROMPT, findTabAction, findTabActionSchema } from './action';

tabRegistry.deps = {
  holderOf: tabId => {
    try {
      return services().threads.holderOf(tabId);
    } catch {
      // Asked before the thread manager exists: nothing is running yet
      return null;
    }
  },
  isOffLimits: windowId => agentWindow.isAgentWindow(windowId),
};
tabRegistry.listen();

registerAgentAction({
  prompt: FIND_TAB_PROMPT,
  create: context =>
    new Action(
      (input: z.infer<typeof findTabActionSchema.schema>) => findTabAction(context, input),
      findTabActionSchema,
    ),
});
