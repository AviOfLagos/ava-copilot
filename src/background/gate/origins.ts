import type { ThreadRecord } from '@extension/storage';

/**
 * Chats in which every commit waits for the click, whatever the confirm settings say: an agent's or a routine's
 * (nobody watches them), and one the user started from WhatsApp (his words, but he is away from the computer, so
 * the click in the panel is the only approval; Ava tells him on WhatsApp that it waits).
 */
export const ALWAYS_ASK_ORIGINS: ReadonlySet<NonNullable<ThreadRecord['origin']>> = new Set([
  'agent',
  'workflow',
  'whatsapp',
]);

/** Whether a chat always asks before it commits. A chat that cannot be read counts as one nobody watches. */
export function alwaysAsks(thread: Pick<ThreadRecord, 'origin'> | undefined): boolean {
  return !thread || Boolean(thread.origin && ALWAYS_ASK_ORIGINS.has(thread.origin));
}
