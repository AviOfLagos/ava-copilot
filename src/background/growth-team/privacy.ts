/**
 * Finds customer details in text an agent wants to put somewhere other people can read (docs/growth-team.md,
 * Part 8, "Privacy"). Plain code, no model: an email address, a phone number, a link that carries a user or
 * account id, and any name or company the caller knows belongs to a customer.
 *
 * It errs on the side of finding too much: a false alarm costs the user one click, a miss puts a customer's
 * details in a public issue.
 */

export interface PrivacyFinding {
  kind: 'email' | 'phone' | 'name' | 'id_link';
  // What was found, cut short, for the user to see why it was stopped
  sample: string;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;
// Seven or more digits with the usual marks between them. A date (2026-11-21), a time, a version number and a
// plain count are not phone numbers.
const PHONE = /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){2,4}(?![\w.-]*\d)/g;
const DATE_LIKE = /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/;
// A link whose path or query names one person or account: /users/123, ?user_id=…, ?email=…, a UUID in a path
const ID_PARAM = /[?&](?:user(?:_?id)?|uid|account(?:_?id)?|member(?:_?id)?|customer(?:_?id)?|email|org(?:_?id)?)=/i;
const ID_PATH = /\/(?:users?|accounts?|members?|customers?|orgs?|organizations?)\/[\w-]{3,}/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

const short = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);

/**
 * Customer details in a piece of text.
 *
 * @param text - What the agent wants to file, post or send
 * @param known - Names and companies taken from the customer's own record (feedback, a sign-up): each is looked
 *   for as a whole word, whatever its case. Very short ones (under 3 letters) are skipped: they match everything.
 * @param allowedLinks - Link prefixes that may carry an id, e.g. the admin console's own page for the feedback
 */
export function findCustomerDetails(text: string, known: string[] = [], allowedLinks: string[] = []): PrivacyFinding[] {
  const found: PrivacyFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: PrivacyFinding['kind'], sample: string) => {
    const key = `${kind}:${sample.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind, sample: short(sample) });
  };

  for (const match of text.matchAll(EMAIL)) add('email', match[0]);
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    if (allowedLinks.some(prefix => prefix && url.startsWith(prefix))) continue;
    if (ID_PARAM.test(url) || ID_PATH.test(url) || UUID.test(url)) add('id_link', url);
  }
  // Links are judged above: digits inside one are not a phone number
  const withoutLinks = text.replace(URL_RE, ' ');
  for (const match of withoutLinks.matchAll(PHONE)) {
    const value = match[0].trim();
    const digits = value.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15 || DATE_LIKE.test(value)) continue;
    add('phone', value);
  }
  for (const name of known) {
    const wanted = name.trim();
    if (wanted.length < 3) continue;
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text)) add('name', wanted);
  }
  return found;
}

/** One line for the user: what was found. */
export function findingsText(findings: PrivacyFinding[]): string {
  const words: Record<PrivacyFinding['kind'], string> = {
    email: 'an email address',
    phone: 'a phone number',
    name: 'a customer or company name',
    id_link: 'a link with a user or account id',
  };
  return [...new Set(findings.map(finding => words[finding.kind]))].join(', ');
}
