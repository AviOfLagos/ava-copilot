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

/** A host pattern as a regular expression: `*` never crosses a dot, and a leading `*.` also means the bare domain. */
function hostRegExp(hostPattern: string): RegExp {
  let source = hostPattern.toLowerCase();
  let prefix = '';
  if (source.startsWith('*.')) {
    prefix = '(?:[a-z0-9-]+\\.)*';
    source = source.slice(2);
  }
  const body = source
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[a-z0-9-]*');
  return new RegExp(`^${prefix}${body}$`);
}

/**
 * Whether a page's address matches a watched pattern. The site and the path are matched apart, so a
 * pattern can never be stretched across them: `x.com*` does not match `x.com.evil.com`. In the site, `*`
 * stays within one label; a bare domain also matches its subdomains; `*.example.com` matches
 * example.com too. In the path, `*` matches anything. The query is only looked at when the pattern has one.
 *
 * Examples: `x.com`, `*.linkedin.com/feed*`, `https://news.ycombinator.com/item*`, `127.0.0.1:8080/page.html?watch=*`.
 */
export function matchesUrlPattern(pattern: string, url: string): boolean {
  const parsed = parseWebUrl(url);
  let rest = pattern.trim();
  if (!parsed || !rest) return false;

  const scheme = /^([a-z*]+):\/\//i.exec(rest);
  if (scheme) {
    const wanted = scheme[1].toLowerCase();
    if (wanted !== '*' && `${wanted}:` !== parsed.protocol) return false;
    rest = rest.slice(scheme[0].length);
  }
  const cut = rest.search(/[/?]/);
  const sitePattern = (cut < 0 ? rest : rest.slice(0, cut)).toLowerCase();
  const pathPattern = cut < 0 ? '' : rest.slice(cut);

  // The site: host, with a port when the pattern names one
  const portMatch = /:(\d+|\*)$/.exec(sitePattern);
  const hostPattern = portMatch ? sitePattern.slice(0, -portMatch[0].length) : sitePattern;
  if (portMatch && portMatch[1] !== '*' && portMatch[1] !== parsed.port) return false;
  const hostname = parsed.hostname.toLowerCase();
  const hostOk = hostPattern.includes('*')
    ? hostRegExp(hostPattern).test(hostname)
    : hostname === hostPattern || hostname.endsWith(`.${hostPattern}`);
  if (!hostOk) return false;

  // The path (and query), only when the pattern has one
  if (!pathPattern) return true;
  const target = `${parsed.pathname}${pathPattern.includes('?') ? parsed.search : ''}`;
  const pathSource = pathPattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pathSource}/?$`, 'i').test(target);
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

const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Whether text is a plain host name as written: lower case letters, digits, hyphens and dots, nothing else. */
export function isHostName(text: string): boolean {
  return text.length <= 253 && HOST_NAME.test(text);
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
  if (!value || !isHostName(value)) return null;
  return wildcard ? `*.${value}` : value;
}

/**
 * The host name a site entry opens (it and its subdomains), or null when it is not a site. Every check of an
 * agent's sites goes through this one parser, so they can never disagree about what an entry allows.
 */
export function siteHost(entry: string): string | null {
  const domain = normalizeDomain(entry);
  return domain === null ? null : domain.replace(/^\*\./, '');
}

/** Whether a host is one of the agent's sites (or a subdomain of one). An empty list allows every site. */
export function hostInDomains(hostname: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return true;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return domains.some(entry => {
    const domain = siteHost(entry);
    return domain !== null && (host === domain || host.endsWith(`.${domain}`));
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
