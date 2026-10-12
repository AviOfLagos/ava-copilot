import { globToRegExp } from '../skills/match';

/**
 * Addresses, sites and topics an agent is tied to, matched without any code from outside. Pure, shared by
 * the background and the panel.
 */

function parseWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a page's address matches a watched pattern. `*` matches anything. A pattern with a scheme is
 * matched against the whole address; one without against host and path; a bare domain matches it and its
 * subdomains; `*.example.com` matches example.com too. The query is only looked at when the pattern has one.
 *
 * Examples: `x.com`, `*.linkedin.com/feed*`, `https://news.ycombinator.com/item*`, `127.0.0.1:8080/page.html?watch=*`.
 */
export function matchesUrlPattern(pattern: string, url: string): boolean {
  const parsed = parseWebUrl(url);
  const trimmed = pattern.trim();
  if (!parsed || !trimmed) return false;
  const query = trimmed.includes('?') ? parsed.search : '';
  if (trimmed.includes('://')) {
    return globToRegExp(trimmed).test(`${parsed.protocol}//${parsed.host}${parsed.pathname}${query}`);
  }
  if (!trimmed.includes('/') && !trimmed.includes('?')) {
    const domain = trimmed.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === domain ||
      hostname.endsWith(`.${domain}`) ||
      parsed.host.toLowerCase() === domain ||
      globToRegExp(domain).test(parsed.host)
    );
  }
  return globToRegExp(trimmed).test(`${parsed.host}${parsed.pathname}${query}`);
}

/**
 * Why a watched pattern cannot be used, or null. It must name a site: a pattern that matches every page
 * (`*`, `*.com`) would wake the agent on everything the user opens.
 */
export function tabPatternIssue(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed) return 'A watched page needs an address pattern, e.g. "x.com/*".';
  if (trimmed.length > 300) return 'A watched address pattern is at most 300 characters.';
  if (/\s/.test(trimmed)) return `"${trimmed}" has spaces; an address pattern has none.`;
  const withoutScheme = trimmed.replace(/^[a-z*]+:\/\//i, '');
  const hostPart = withoutScheme.split(/[/?#]/)[0] ?? '';
  const host = hostPart.replace(/:(\d+|\*)$/, '').toLowerCase();
  const bare = host.startsWith('*.') ? host.slice(2) : host;
  if (!bare || bare.includes('*') || !/^[a-z0-9.-]+$/.test(bare) || !/[a-z0-9]/.test(bare)) {
    return `"${trimmed}" must name a site, e.g. "x.com/*" or "*.linkedin.com/feed*"; it cannot match every site.`;
  }
  if (host.startsWith('*.') && !bare.includes('.')) {
    return `"${trimmed}" matches a whole top-level domain; name the site.`;
  }
  return null;
}

/**
 * A site as the host name it stands for: lower case, without scheme, path or port; `*.` kept. Null when it
 * is not a host name.
 */
export function normalizeDomain(entry: string): string | null {
  let value = entry.trim().toLowerCase();
  if (!value) return null;
  const wildcard = value.startsWith('*.');
  if (wildcard) value = value.slice(2);
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split(/[/?#]/)[0] ?? '';
  value = value.replace(/:\d+$/, '').replace(/\.$/, '');
  if (value.startsWith('www.') && !wildcard) value = value.slice(4);
  if (
    !value ||
    value.length > 253 ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value)
  ) {
    return null;
  }
  return wildcard ? `*.${value}` : value;
}

/** Whether a host is one of the agent's sites (or a subdomain of one). An empty list allows every site. */
export function hostInDomains(hostname: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return true;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return domains.some(entry => {
    const domain = entry.startsWith('*.') ? entry.slice(2) : entry;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** Whether a page is on the agent's sites. Pages that are not on the web (about:blank) are not counted. */
export function urlInDomains(url: string, domains: readonly string[]): boolean {
  const parsed = parseWebUrl(url);
  return parsed ? hostInDomains(parsed.hostname, domains) : true;
}

// A topic an agent posts to: lower case letters, digits, ".", "_" and "-", e.g. "social.mentions"
export const TOPIC_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// A topic it listens to may end in a wildcard, e.g. "news.*"; never "*" alone
export const LISTEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}(\*)?$/;

/** Whether a topic someone listens to (exact, or with `*`, e.g. "news.*") takes a posted topic. */
export function topicMatches(listened: string, posted: string): boolean {
  const pattern = listened.trim().toLowerCase();
  const topic = posted.trim().toLowerCase();
  if (!pattern || !topic) return false;
  if (!pattern.includes('*')) return pattern === topic;
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${source}$`).test(topic);
}
