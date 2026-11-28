import { DESKTOP_TEXT_MAX, desktopChatIdSchema } from '@protocol';

/** What the window sends is checked here too: the main process trusts nothing from a page. */
export function isChatId(value: unknown): value is string {
  return desktopChatIdSchema.safeParse(value).success;
}

/** The words to send, trimmed, or null when there are none or too many. */
export function checkText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const words = value.trim();
  return words && words.length <= DESKTOP_TEXT_MAX ? words : null;
}
