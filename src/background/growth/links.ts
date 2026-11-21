import type { ProductProfile } from '@extension/storage';

/**
 * `make_link`: every link an agent puts in a post, a reply or an email goes through here, so it carries
 * `utm_source`, `utm_medium` and `utm_campaign` and a sign-up can be traced to where it came from
 * (docs/growth-team.md, Part 7). Plain code: the same input always gives the same link.
 */

export interface LinkRequest {
  url: string;
  // Where the link is placed: "x", "linkedin", "reddit", "email"
  source: string;
  // The kind of placement: "social", "email", "community", "listing"
  medium: string;
  // What it belongs to: the week's experiment, a post, a launch
  campaign: string;
}

export type LinkResult = { ok: true; url: string; target: string; tags: LinkRequest } | { ok: false; error: string };

/** A tag as analytics tools expect it: lower case, words joined by "-", nothing else. */
export function utmTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const hostOf = (url: string | undefined): string => {
  try {
    return new URL(url ?? '').hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/**
 * Tags a link to the product's own site. A link to anywhere else is refused: tagging somebody else's page
 * traces nothing, and a link an agent hands out must lead where the profile says the product lives.
 */
export function makeLink(profile: Pick<ProductProfile, 'url' | 'name'>, request: LinkRequest): LinkResult {
  const site = hostOf(profile.url);
  if (!site)
    return {
      ok: false,
      error: `The product profile of ${profile.name || 'this workspace'} has no site set, so there is nothing to link to.`,
    };
  let target: URL;
  try {
    target = new URL(request.url.trim());
  } catch {
    return { ok: false, error: 'That is not a full web address (https://…).' };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, error: 'Only web addresses can be tagged.' };
  }
  const host = target.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== site && !host.endsWith(`.${site}`)) {
    return {
      ok: false,
      error: `make_link only tags links to the product's own site (${site}). ${host} is another site.`,
    };
  }
  const tags = { source: utmTag(request.source), medium: utmTag(request.medium), campaign: utmTag(request.campaign) };
  const empty = Object.entries(tags).find(([, value]) => !value)?.[0];
  if (empty) return { ok: false, error: `The ${empty} is empty: give a short word for it (letters and numbers).` };

  // Tags already on the address are replaced, never doubled
  target.searchParams.set('utm_source', tags.source);
  target.searchParams.set('utm_medium', tags.medium);
  target.searchParams.set('utm_campaign', tags.campaign);
  const clean = new URL(request.url.trim());
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) clean.searchParams.delete(key);
  return { ok: true, url: target.href, target: clean.href, tags: { url: target.href, ...tags } };
}
