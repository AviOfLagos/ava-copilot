import { z } from 'zod';
import { registerCommand } from '../registry';
import { services } from '../registry/services';
import { tabPanels } from './tabPanels';

// ── Per-tab panels: which chat a tab's side panel shows (tabPanels.ts) ─────────────────────────────

/** A tab's panel opened a chat (a past one from its list, or one it was asked to show): the chat lives there now. */
registerCommand(
  'tab_panel_open',
  z.object({ type: z.literal('tab_panel_open'), tabId: z.number().int(), threadId: z.string() }),
  async (input, context) => {
    try {
      const result = await services().threads.openOnTab(input.threadId, input.tabId);
      context.reply({ type: 'tab_panel_opened', requestId: context.requestId, ...result });
    } catch (error) {
      context.reply({
        type: 'error',
        requestId: context.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

/** "New conversation" on a tab's panel: the tab goes back to having no chat until the first message is sent. */
registerCommand(
  'tab_panel_clear',
  z.object({ type: z.literal('tab_panel_clear'), tabId: z.number().int() }),
  async input => {
    await tabPanels.clear(input.tabId);
  },
);
