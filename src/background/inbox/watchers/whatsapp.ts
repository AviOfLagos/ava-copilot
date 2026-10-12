import type { Watcher, WatcherConversation } from './types';

/** Whether a tab's address is WhatsApp Web, where the watcher is allowed to look. */
export function matchesWhatsappUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'web.whatsapp.com';
  } catch {
    return false;
  }
}

/**
 * Runs in the WhatsApp Web page. Self-contained per CLAUDE.md: no imports, no outer variables. Reads
 * only the chat list already on screen, and only rows WhatsApp itself marked unread; never opens a
 * chat, never scrolls, never reads a message beyond its own preview line.
 */
export const probeWhatsapp = (): WatcherConversation[] => {
  const out: { externalId: string; sender: string; snippet: string }[] = [];
  try {
    const list =
      document.querySelector('[aria-label="Chat list"]') ?? document.querySelector('[data-testid="chat-list"]');
    if (!list) return out;
    const rows = list.querySelectorAll('[data-testid="cell-frame-container"], [role="listitem"]');
    rows.forEach((row, index) => {
      const unread = row.querySelector('[aria-label$="unread message"], [aria-label$="unread messages"]');
      if (!unread) return;
      const titleEl = row.querySelector('[data-testid="cell-frame-title"] span[title], span[dir="auto"][title]');
      const sender = (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim();
      if (!sender) return;
      const snippetEl = row.querySelector('[data-testid="cell-frame-secondary"] span[title], span[title][dir="ltr"]');
      const snippet = (snippetEl?.getAttribute('title') || snippetEl?.textContent || '').trim();
      // A stable id: WhatsApp keys rows by the chat's own id when it is present
      const stableId = row.getAttribute('data-id') || row.id || `${index}:${sender}`;
      out.push({ externalId: stableId, sender, snippet });
    });
  } catch {
    // Page structure the probe does not recognise: nothing read, nothing broken
  }
  return out;
};

export const whatsappWatcher: Watcher = {
  source: 'whatsapp-web',
  settingKey: 'watchWhatsapp',
  matchesUrl: matchesWhatsappUrl,
  probe: probeWhatsapp,
};
