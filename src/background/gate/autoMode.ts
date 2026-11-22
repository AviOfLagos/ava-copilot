import { ALWAYS_ASK_KINDS, threadStore } from '@extension/storage';
import type { CommitKind } from '@extension/storage';
import { alwaysAsks } from './origins';

/**
 * Auto mode: "do this task without asking me". While it is on for a task, the confirm gate lets submits, saves,
 * posts and sends go ahead, tainted chat or not, and says so in the task's timeline.
 *
 * Who may switch it on: only the user's own click in the side panel (the `thread_auto_mode` command, which the
 * background accepts from the panel's port alone). Nothing the model writes, no page and no tool result can reach
 * it: the flag lives on the thread record, and nothing in this file or in the gate writes it.
 *
 * What it never covers (still asks, here and nowhere else decided): money and purchases, deleting, and changing
 * who has access (`ALWAYS_ASK_KINDS`), and anything that needs the user's hands, such as a password, a code or a
 * CAPTCHA (`needs_user` is handled before the gate gets here). A step that was already done once (do once) also
 * still asks.
 */

/** The kinds Auto mode never answers for. Shown next to the toggle. */
export const autoModeAsks = (): readonly CommitKind[] => ALWAYS_ASK_KINDS;

/**
 * Whether Auto mode lets a commit of this kind run without a card. False when the flag is off or cannot be read
 * (fails closed), for a run nobody watches (an agent's, a routine's, WhatsApp), and for the kinds above.
 */
export async function autoModeAllows(taskId: string, kind: CommitKind): Promise<boolean> {
  if (autoModeAsks().includes(kind)) return false;
  const thread = await threadStore.get(taskId).catch(() => undefined);
  if (!thread || alwaysAsks(thread)) return false;
  return thread.autoMode === true;
}
