import type { Watcher, WatcherConversation } from './types';

/** Whether a tab's address is Gmail's web client. */
export function matchesGmailUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'mail.google.com';
  } catch {
    return false;
  }
}

/**
 * Runs in a Gmail page. Self-contained per CLAUDE.md. Gmail marks an unread row with its own class
 * and a bold sender/subject; the row's thread id (when Gmail sets one) is the stable id, else the
 * sender and subject together stand in for one.
 */
export const probeGmail = (): WatcherConversation[] => {
  const out: { externalId: string; sender: string; snippet: string }[] = [];
  try {
    const rows = document.querySelectorAll('tr.zA, [role="row"][data-legacy-thread-id]');
    rows.forEach((row, index) => {
      const unread = row.classList.contains('zE') || row.getAttribute('aria-label')?.includes('Unread');
      if (!unread) return;
      const senderEl = row.querySelector('span[email], .yX.xY, .bA4');
      const sender = (senderEl?.getAttribute('name') || senderEl?.textContent || '').trim();
      if (!sender) return;
      const subjectEl = row.querySelector('.y6 span[id], .bog');
      const snippetEl = row.querySelector('.y2');
      const subject = (subjectEl?.textContent || '').trim();
      const preview = (snippetEl?.textContent || '').trim();
      const snippet = [subject, preview].filter(Boolean).join(' - ');
      const stableId = row.getAttribute('data-legacy-thread-id') || row.id || `${index}:${sender}:${subject}`;
      out.push({ externalId: stableId, sender, snippet });
    });
  } catch {
    // Unrecognised page structure: nothing read, nothing broken
  }
  return out;
};

export const gmailWatcher: Watcher = {
  source: 'gmail-web',
  settingKey: 'watchGmail',
  matchesUrl: matchesGmailUrl,
  probe: probeGmail,
};
