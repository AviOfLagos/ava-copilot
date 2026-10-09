/**
 * Whether a tab has played sound lately. A video or a call can say "Hey Ava" and what follows, so a
 * conversation the wake word started is guarded while sound is playing or has just played.
 */

// Sound this recent still counts: a clip may stop the moment after it speaks
const RECENT_MS = 15_000;
let lastAudible = 0;

/** Starts noting when tabs play sound. */
export function watchSound(): void {
  chrome.tabs.onUpdated.addListener((_tabId, change) => {
    // Turning silent means it was playing a moment ago
    if (change.audible !== undefined) lastAudible = Date.now();
  });
}

/** Whether any tab plays sound now or did lately. When it cannot be told, the answer is yes. */
export async function soundRecently(now = Date.now()): Promise<boolean> {
  if (now - lastAudible < RECENT_MS) return true;
  try {
    return (await chrome.tabs.query({ audible: true })).length > 0;
  } catch {
    return true;
  }
}
