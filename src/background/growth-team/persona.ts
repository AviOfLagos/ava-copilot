import { PERSONA_SOURCE_NAMES } from '@extension/storage';
import type { TeamAction } from '@extension/storage';

/**
 * A personality is inspired by a person's public work; the agent is never that person (docs/growth-team.md,
 * Part 8). The prompt says so, and this makes it code: a draft for other people that names one of those people or
 * their books, or speaks as them, is refused before it reaches the Inbox.
 */

// What other people read: drafts and issues. Requests to the user (spending, a tool) are only for the user
const OUTWARD: ReadonlySet<TeamAction> = new Set([
  'post',
  'reply',
  'outreach_email',
  'follow_up',
  'listing',
  'customer_issue',
]);

export const isOutward = (action: TeamAction): boolean => OUTWARD.has(action);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole words, case ignored, with spaces, a hyphen, a dot, an underscore or nothing between the parts
const wordsOf = (name: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${plain(name).trim().split(/\s+/).map(escape).join('[\\s\\-_.]*')}(?![\\p{L}\\p{N}])`,
    'iu',
  );

// Accents and invisible characters do not hide a name: "Séan", "Sean\u200bEllis"
function plain(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '');
}

const PATTERNS = Object.values(PERSONA_SOURCE_NAMES)
  .flat()
  .map(name => ({ name, pattern: wordsOf(name) }));

/** The source names the text holds, in the order of the list; empty when it names none. */
export function namedSources(text: string): string[] {
  const seen = plain(text);
  return PATTERNS.filter(entry => entry.pattern.test(seen)).map(entry => entry.name);
}

/** Why a draft may not go to the Inbox as written, or null when it may. */
export function personaRefusal(action: TeamAction, ...texts: string[]): string | null {
  if (!isOutward(action)) return null;
  const named = namedSources(texts.join('\n'));
  if (!named.length) return null;
  return `The draft names ${named.map(name => `"${name}"`).join(', ')}: your personality is only inspired by that work. Never name the person or their books, and never write as them, in anything for other people. Write it again in the product's own voice.`;
}
