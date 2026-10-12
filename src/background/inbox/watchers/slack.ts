import type { Watcher, WatcherConversation } from './types';

/** Whether a tab's address is Slack's web client. */
export function matchesSlackUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.slack.com');
  } catch {
    return false;
  }
}

/**
 * Runs in a Slack web page. Self-contained per CLAUDE.md. The channel sidebar marks an unread
 * channel or DM bold with a badge, but rarely shows a message preview there, so the snippet falls
 * back to a plain "new messages" line when Slack does not expose one.
 */
export const probeSlack = (): WatcherConversation[] => {
  const out: { externalId: string; sender: string; snippet: string }[] = [];
  try {
    const sidebar =
      document.querySelector('[aria-label="Channels"]') ?? document.querySelector('[data-qa="channel_sidebar"]');
    if (!sidebar) return out;
    const rows = sidebar.querySelectorAll('[data-qa="virtual-list-item"], [role="listitem"]');
    rows.forEach((row, index) => {
      const badge = row.querySelector('[data-qa="channel_sidebar_badge"], [aria-label*="unread" i]');
      if (!badge) return;
      const nameEl = row.querySelector('[data-qa="channel_sidebar_name"], span[dir="auto"]');
      const sender = (nameEl?.textContent || '').trim();
      if (!sender) return;
      const previewEl = row.querySelector('[data-qa="channel_sidebar_channel_preview"]');
      const snippet = (previewEl?.textContent || '').trim() || `New messages in ${sender}`;
      const stableId = row.getAttribute('data-channel-sidebar-channel-id') || row.id || `${index}:${sender}`;
      out.push({ externalId: stableId, sender, snippet });
    });
  } catch {
    // Unrecognised page structure: nothing read, nothing broken
  }
  return out;
};

export const slackWatcher: Watcher = {
  source: 'slack-web',
  settingKey: 'watchSlack',
  matchesUrl: matchesSlackUrl,
  probe: probeSlack,
};
