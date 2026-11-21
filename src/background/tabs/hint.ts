/**
 * Which open site a task names, worked out from its words and the sites that are open. Plain code, no model:
 * "Go to Facebook and reply to X" names facebook.com when a Facebook tab is open, and nothing when none is.
 *
 * It is deliberately cautious. A task about what is on screen ("summarise this page") names no site, and a
 * site's name only counts after a word that points at a place ("on Slack", "open LinkedIn"), so "find linear
 * algebra courses" does not take the Linear tab.
 */

// Second-level names that sit under a country code: "bbc.co.uk" is the site "bbc.co.uk", not "co.uk"
const UNDER_COUNTRY = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

// The task is about the page in front of the user: it stays there
const ON_SCREEN =
  /\b(?:this|current|that|the open|the active)\s+(?:page|tab|site|website|article|post|video|form|doc|document|email|mail|message|thread|chat|sheet|spreadsheet|pdf|window|screen|one)\b|\b(?:on|in) (?:screen|front of me)\b|\bhere\b/i;

// Words that point at a place, right before its name
const CUES = [
  'on',
  'to',
  'in',
  'into',
  'at',
  'from',
  'via',
  'open',
  'check',
  'visit',
  'use',
  'using',
  'search',
  'through',
  'inside',
];

// Places where every name under them is somebody else's site: "foo.github.io" is the site, not "github.io"
const SHARED = new Set([
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'onrender.com',
  'fly.dev',
  'blogspot.com',
  'wordpress.com',
  'substack.com',
  'notion.site',
  'webflow.io',
  'framer.app',
  'replit.app',
  'glitch.me',
  'ngrok.io',
  'ngrok-free.app',
]);

// The first part of an address that means "the app itself", not another product of the same company:
// "app.slack.com" is Slack, while "mail.google.com" is not what "Google" names
const APP_PARTS = new Set(['app', 'web', 'm', 'mobile', 'my', 'go', 'dashboard', 'console', 'portal']);

/** The site a host belongs to: "app.slack.com" → "slack.com", "news.bbc.co.uk" → "bbc.co.uk". */
export function siteOf(host: string): string {
  const parts = host
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.')
    .filter(Boolean);
  if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1]!)) return parts.join('.');
  const last = parts[parts.length - 1]!;
  const two = parts.slice(-2).join('.');
  const keep = SHARED.has(two) || (last.length === 2 && UNDER_COUNTRY.has(parts[parts.length - 2]!)) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

/** The name people call a site by: "slack" for app.slack.com. Empty when the host is an address, not a name. */
export function siteLabel(host: string): string {
  const site = siteOf(host);
  if (/^[\d.]+$/.test(site) || SHARED.has(site)) return '';
  return site.split('.')[0] ?? '';
}

/**
 * Whether a host is the site's own front door: the site itself ("facebook.com") or its app ("app.slack.com",
 * "m.facebook.com"). "mail.google.com" and "docs.google.com" are not: each is a product of its own, and a task
 * that says "Google" does not mean either of them.
 */
export function isFrontDoor(host: string): boolean {
  const clean = host.toLowerCase().replace(/^www\./, '');
  const site = siteOf(clean);
  if (clean === site) return true;
  const extra = clean.slice(0, -(site.length + 1));
  return APP_PARTS.has(extra);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The host among `hosts` (the sites of the free open tabs, most recently used first) that the task names, or
 * null. A written address ("facebook.com") wins over a name ("Facebook"); with several, the one named first.
 *
 * The answer is always one exact host that is open, never a whole domain: "google.com" written out means a tab on
 * google.com, not Gmail, and the name "Google" never picks Gmail or Docs.
 */
export function siteNamed(text: string, hosts: string[]): string | null {
  if (!text.trim() || !hosts.length || ON_SCREEN.test(text)) return null;
  const lower = text.toLowerCase();
  const open = [...new Set(hosts.map(host => host.toLowerCase().replace(/^www\./, '')).filter(Boolean))];

  // 1. An address written out: the tab on exactly that address, or on the app of that site
  const written = lower.matchAll(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?/g);
  for (const match of written) {
    const domain = match[1]!.replace(/^www\./, '');
    const exact = open.find(host => host === domain);
    if (exact) return exact;
    const app = open.find(host => siteOf(host) === domain && isFrontDoor(host));
    if (app) return app;
  }

  // 2. A site's name after a word that points at a place
  let best: { at: number; host: string } | null = null;
  for (const host of open) {
    const label = siteLabel(host);
    if (label.length < 3 || !isFrontDoor(host)) continue;
    const pattern = new RegExp(`\\b(?:${CUES.join('|')})\\s+(?:(?:my|the|our)\\s+)?${escape(label)}\\b`, 'i');
    const found = pattern.exec(lower);
    if (found && (best === null || found.index < best.at)) best = { at: found.index, host };
  }
  return best?.host ?? null;
}
