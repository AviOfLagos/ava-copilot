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

/** The site a host belongs to: "app.slack.com" → "slack.com", "news.bbc.co.uk" → "bbc.co.uk". */
export function siteOf(host: string): string {
  const parts = host
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.')
    .filter(Boolean);
  if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1]!)) return parts.join('.');
  const last = parts[parts.length - 1]!;
  const keep = last.length === 2 && UNDER_COUNTRY.has(parts[parts.length - 2]!) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

/** The name people call a site by: "slack" for app.slack.com. Empty when the host is an address, not a name. */
export function siteLabel(host: string): string {
  const site = siteOf(host);
  if (/^[\d.]+$/.test(site)) return '';
  return site.split('.')[0] ?? '';
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The site among `hosts` (the sites of the free open tabs) that the task names, or null. A written address
 * ("facebook.com") wins over a name ("Facebook"); with several, the one named first.
 */
export function siteNamed(text: string, hosts: string[]): string | null {
  if (!text.trim() || !hosts.length || ON_SCREEN.test(text)) return null;
  const lower = text.toLowerCase();
  const open = [...new Set(hosts.map(host => host.toLowerCase().replace(/^www\./, '')).filter(Boolean))];

  // 1. An address written out
  const written = lower.matchAll(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?/g);
  for (const match of written) {
    const domain = match[1]!.replace(/^www\./, '');
    if (open.some(host => host === domain || host.endsWith(`.${domain}`))) return domain;
  }

  // 2. A site's name after a word that points at a place
  let best: { at: number; site: string } | null = null;
  for (const host of open) {
    const label = siteLabel(host);
    if (label.length < 3) continue;
    const pattern = new RegExp(`\\b(?:${CUES.join('|')})\\s+(?:(?:my|the|our)\\s+)?${escape(label)}\\b`, 'i');
    const found = pattern.exec(lower);
    if (found && (best === null || found.index < best.at)) best = { at: found.index, site: siteOf(host) };
  }
  return best?.site ?? null;
}
