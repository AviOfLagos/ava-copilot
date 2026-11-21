import { canonicalEmail, teamStore } from '@extension/storage';

/**
 * Who an email may go to (docs/growth-team.md, Part 12), checked in the queue itself so no path around it exists:
 * a work address, never a personal mailbox, and never one on the do-not-write list. Addresses are compared in one
 * canonical form (lower case, no "+tag"), the same form the list and the contacts are kept in.
 */

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;

// Personal mailboxes, by name whatever the country ending (yahoo.co.uk, hotmail.com.br, gmx.net…)
const PERSONAL_NAMES =
  /^(?:gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|windowslive|aol|icloud|proton|protonmail|gmx|yandex|zoho|mail|inbox|fastmail|tutanota|tuta|hushmail|lycos|rediffmail|naver|daum|hanmail|libero|virgilio|laposte|orange|wanadoo|free|sfr|seznam|wp|onet|interia|rambler|sina|sohu|aliyun|foxmail)\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const PERSONAL_EXACT = new Set([
  'me.com',
  'mac.com',
  'pm.me',
  'hey.com',
  'qq.com',
  '163.com',
  '126.com',
  'yeah.net',
  'web.de',
  't-online.de',
  'freenet.de',
  'mail.ru',
  'bk.ru',
  'list.ru',
  'uol.com.br',
  'bol.com.br',
  'terra.com.br',
  'ig.com.br',
  'btinternet.com',
  'sky.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
]);

export const isEmail = (address: string) => EMAIL.test(address.trim());

export function isPersonalMailbox(address: string): boolean {
  const domain = canonicalEmail(address).split('@')[1] ?? '';
  return PERSONAL_EXACT.has(domain) || PERSONAL_NAMES.test(domain);
}

/** Why an email may not go to this address, or null when it may. */
export async function addressRefusal(address: string): Promise<string | null> {
  if (!isEmail(address)) return `"${address}" is not an email address.`;
  if (isPersonalMailbox(address)) {
    return `${canonicalEmail(address).split('@')[1]} is a personal mailbox. Outreach goes to work addresses found on a public, relevant page only.`;
  }
  const suppressed = await teamStore.suppressed(address);
  if (suppressed) return `That address asked not to be written to (${suppressed.why}); no agent writes to it again.`;
  return null;
}
