import { ensureOffscreen } from '../../offscreen';
import { OFFSCREEN_VOICE_TARGET } from './wire';

/**
 * Sends a local voice or speech command to the offscreen document, opening it first. A document opened a moment
 * ago may not be taking messages yet, so that one error is retried briefly.
 */
export async function toVoiceOffscreen<T = Record<string, unknown>>(message: Record<string, unknown>): Promise<T> {
  await ensureOffscreen();
  for (let attempt = 0; ; attempt++) {
    try {
      return (await chrome.runtime.sendMessage({ ...message, target: OFFSCREEN_VOICE_TARGET })) as T;
    } catch (error) {
      if (attempt >= 10 || !String(error).includes('Receiving end does not exist')) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

/** Asks the offscreen document only if it is already open (never opens it just to ask). */
export async function askVoiceOffscreen<T>(message: Record<string, unknown>): Promise<T | null> {
  const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (open.length === 0) return null;
  return ((await chrome.runtime.sendMessage({ ...message, target: OFFSCREEN_VOICE_TARGET }).catch(() => null)) ??
    null) as T | null;
}
