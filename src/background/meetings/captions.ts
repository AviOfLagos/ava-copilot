/**
 * Reading a meeting's own live captions from the page, for when its audio cannot be captured.
 * Captions only exist when the user turns them on in the meeting.
 */

// Caption elements on the platforms in use; each holds one speaker's current line
export const CAPTION_SELECTORS = [
  // Google Meet
  'div[jsname="tgaKEf"]',
  '[aria-label="Captions"] [jsname]',
  // Zoom web client
  '.live-transcription-subtitle__item',
  // Microsoft Teams
  '[data-tid="closed-caption-text"]',
];

/**
 * Runs in the meeting page. Watches the caption elements and reports each line once it has stopped
 * changing. Self-contained, because it is sent to the page as source text.
 */
export function watchCaptions(meetingId: string, selectors: string[]): boolean {
  type Watch = { stop: () => void };
  const holder = window as unknown as { __aviCaptions?: Watch };
  holder.__aviCaptions?.stop();

  const SETTLE_MS = 1500;
  const seen = new Map<Element, { text: string; sent: string; changedAt: number }>();

  const speakerOf = (element: Element): string => {
    const named = element.closest('[data-speaker], [data-tid="closed-caption-message"]');
    const attribute = named?.getAttribute('data-speaker');
    if (attribute) return attribute;
    const author = named?.querySelector('[data-tid="author"]');
    return author?.textContent?.trim() ?? '';
  };

  const timer = setInterval(() => {
    const now = Date.now();
    const lines: { speaker: string; text: string }[] = [];
    for (const element of document.querySelectorAll(selectors.join(','))) {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      const entry = seen.get(element) ?? { text: '', sent: '', changedAt: now };
      if (text !== entry.text) {
        entry.text = text;
        entry.changedAt = now;
      } else if (text && text !== entry.sent && now - entry.changedAt >= SETTLE_MS) {
        // A line that grew since it was sent only reports what is new
        const fresh = entry.sent && text.startsWith(entry.sent) ? text.slice(entry.sent.length).trim() : text;
        if (fresh) lines.push({ speaker: speakerOf(element), text: fresh });
        entry.sent = text;
      }
      seen.set(element, entry);
    }
    if (lines.length > 0) {
      chrome.runtime.sendMessage({ type: 'meeting_captions', meetingId, lines }).catch(() => {});
    }
  }, 500);

  holder.__aviCaptions = { stop: () => clearInterval(timer) };
  return true;
}

/** Runs in the meeting page: stops watching captions. */
export function stopWatchingCaptions(): boolean {
  const holder = window as unknown as { __aviCaptions?: { stop: () => void } };
  holder.__aviCaptions?.stop();
  delete holder.__aviCaptions;
  return true;
}

/** Runs in the meeting page: whether it shows captions right now. */
export function pageHasCaptions(selectors: string[]): boolean {
  return document.querySelector(selectors.join(',')) !== null;
}
