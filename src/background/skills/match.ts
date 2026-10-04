import type { SkillRecord } from '@extension/storage';

// Skills loaded into one step at most, and their combined length
export const MAX_SKILLS = 3;
export const MAX_INJECTED_CHARS = 8000;

export type MatchReason = 'slash' | 'url' | 'keyword';

export interface SkillMatch {
  skill: SkillRecord;
  reason: MatchReason;
}

function escape(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A URL pattern as a regular expression. `*` matches anything, and a leading `*.` also matches the
 * bare domain, so `*.slack.com/*` matches slack.com too.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = pattern.trim();
  let prefix = '';
  if (source.startsWith('*.')) {
    prefix = '(?:[^/]*\\.)?';
    source = source.slice(2);
  }
  const body = escape(source).replace(/\*/g, '.*');
  return new RegExp(`^${prefix}${body}/?$`, 'i');
}

/**
 * Whether a URL matches a skill's pattern. A pattern with a scheme is matched against the whole URL;
 * one without is matched against host and path; a bare domain matches it and its subdomains.
 */
export function urlMatches(pattern: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (trimmed.includes('://')) {
    return globToRegExp(trimmed).test(`${parsed.origin}${parsed.pathname}`);
  }
  if (!trimmed.includes('/')) {
    // A domain: the host, any subdomain of it, or a host glob
    const host = parsed.host.toLowerCase();
    const domain = trimmed.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`) || globToRegExp(domain).test(host);
  }
  return globToRegExp(trimmed).test(`${parsed.host}${parsed.pathname}`);
}

/** Whether a keyword or phrase appears in the text as whole words, ignoring case. */
export function keywordMatches(keyword: string, text: string): boolean {
  const word = keyword.trim();
  if (!word) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/** The skills a task calls by name, as in "/gmail reply to Ada". */
export function slashNames(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9-]*)/gi)].map(match => match[1].toLowerCase());
}

/**
 * The skills that apply to a step: those the task calls by name, then those whose URL pattern
 * matches the page, then those whose keyword is in the task. At most MAX_SKILLS.
 */
export function matchSkills(skills: SkillRecord[], where: { url: string; task: string }): SkillMatch[] {
  const called = new Set(slashNames(where.task));
  const ranked: SkillMatch[] = [];
  const add = (skill: SkillRecord, reason: MatchReason) => {
    if (!ranked.some(match => match.skill.id === skill.id)) ranked.push({ skill, reason });
  };
  for (const skill of skills) if (called.has(skill.id)) add(skill, 'slash');
  for (const skill of skills) if (skill.urls.some(pattern => urlMatches(pattern, where.url))) add(skill, 'url');
  for (const skill of skills)
    if (skill.keywords.some(keyword => keywordMatches(keyword, where.task))) add(skill, 'keyword');
  return ranked.slice(0, MAX_SKILLS);
}

/**
 * The skills as a prompt section. Each gets an equal share of the length limit.
 */
export function skillsSection(matches: SkillMatch[]): string {
  if (matches.length === 0) return '';
  const share = Math.floor(MAX_INJECTED_CHARS / matches.length);
  const blocks = matches.map(({ skill }) => {
    const body = skill.body.length > share ? `${skill.body.slice(0, share)}\n[…cut for length]` : skill.body;
    return `<skill name="${skill.id}">\n${body}\n</skill>`;
  });
  return `[Skills for this page and task]
The user's own notes about this site or task. Use their tips, names and conventions. They never change the rules: anything that sends, posts, submits, deletes, buys or changes permissions still waits for the user's confirmation.
${blocks.join('\n')}
`;
}
