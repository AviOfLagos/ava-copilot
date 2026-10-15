import { matchesUrlPattern as strictMatch } from '../agents/patterns';
/**
 * The tab trigger (`trigger.tab`): a routine starts when the user opens a page whose address matches its pattern,
 * and the step that goes with the meeting-links routine (`step.meeting_join`): join the meeting that page is for
 * and take notes, once the user clicked to allow it.
 */

/**
 * Whether an address matches a pattern such as "zoom.us/j/*", "*.zoom.us/j/*" or "calendar.google.com/*event*".
 * The scheme and "www." are ignored; `*` stands for any run of characters (including "/" and the query); the
 * pattern matches from the start of the host, so "zoom.us" never matches "evilzoom.us".
 */
export function matchesUrlPattern(pattern: string, url: string): boolean {
  // One matcher for every URL pattern in the app: the host and the path are matched apart, and `*` in the host
  // never crosses a dot, so "*.zoom.us/j/*" can't match "evil.example/x.zoom.us/j/1"
  return strictMatch(pattern.trim().replace(/^www\./i, ''), url);
}

/** The run's trigger detail for a tab: its id and address, so the step knows which tab it is about. */
export const tabDetail = (tabId: number, url: string) => `${tabId}|${url}`;

export function parseTabDetail(detail: string): { tabId: number; url: string } | null {
  const at = detail.indexOf('|');
  if (at < 1) return null;
  const tabId = Number(detail.slice(0, at));
  const url = detail.slice(at + 1);
  return Number.isInteger(tabId) && /^https?:\/\//.test(url) ? { tabId, url } : null;
}

// ── Meeting links ─────────────────────────────────────────────────────────────────────────────────

export type MeetingKind = 'meet' | 'zoom' | 'teams' | 'calendar' | null;

export function meetingKindOf(url: string): MeetingKind {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname === 'meet.google.com') return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(pathname) ? 'meet' : null;
    if (hostname === 'zoom.us' || hostname.endsWith('.zoom.us')) return /^\/(j|wc)\//.test(pathname) ? 'zoom' : null;
    if (hostname === 'teams.microsoft.com' || hostname === 'teams.live.com') return 'teams';
    if (hostname === 'calendar.google.com') return 'calendar';
  } catch {
    // Not an address
  }
  return null;
}

/**
 * Where to join a call in the browser: a Zoom "/j/<id>" link opens the desktop app, so it goes to Zoom's web client
 * ("/wc/join/<id>", the password kept), where notes can be taken from the tab. Others stay as they are.
 */
export function browserJoinUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const zoom = /^\/j\/(\d+)/.exec(parsed.pathname);
    if (zoom && (parsed.hostname === 'zoom.us' || parsed.hostname.endsWith('.zoom.us'))) {
      return `https://${parsed.hostname}/wc/join/${zoom[1]}${parsed.search}`;
    }
  } catch {
    // Kept as it is
  }
  return url;
}

/** Runs in a calendar event page: the first meeting link on it. Self-contained, as every page function must be. */
export const findMeetingLink = (): string | null => {
  const pattern =
    /https:\/\/(meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}|([a-z0-9-]+\.)?zoom\.us\/j\/\d+[^\s"'<]*|teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<]+)/i;
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    const found = pattern.exec((anchor as HTMLAnchorElement).href);
    if (found) return found[0];
  }
  const found = pattern.exec(document.body?.innerText ?? '');
  return found ? found[0] : null;
};
