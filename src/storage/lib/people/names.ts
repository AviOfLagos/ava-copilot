import type { HandleKind, PersonHandle } from './types';

/**
 * Plain rules for comparing names, addresses and handles. No model: the same input always gives the same key.
 */

const MAX_NAME = 120;

// What Meet and other tools add to a display name and is not part of it
const DISPLAY_SUFFIXES = /\s*[([](you|presenting|host|co-host|guest|external|organizer|organiser|me)[)\]]\s*$/i;

/** A display name as shown, tidied: spaces collapsed, quotes and tool suffixes such as "(You)" dropped. */
export function cleanName(text: string | null | undefined): string {
  let value = (text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3 && DISPLAY_SUFFIXES.test(value); i++) value = value.replace(DISPLAY_SUFFIXES, '').trim();
  value = value.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  return value.slice(0, MAX_NAME);
}

/** The key two spellings of one name share: case, accents and punctuation at the edges do not count. */
export function nameKey(text: string | null | undefined): string {
  return cleanName(text)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._'\- ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s._'-]+|[\s._'-]+$/g, '');
}

/** The first word of a name key, for "Ada" against "Ada Obi". */
export function firstNameOf(key: string): string {
  return key.split(' ')[0] ?? '';
}

/** Whether a key is one word, the only kind a first-name match is tried for. */
export const isSingleWord = (key: string) => key.length > 0 && !key.includes(' ');

const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}$/;

/** An address in lower case, or null when it is not one. */
export function cleanEmail(value: string | null | undefined): string | null {
  const email = (value ?? '')
    .trim()
    .replace(/^mailto:/i, '')
    .toLowerCase();
  return EMAIL.test(email) ? email : null;
}

/** A phone number as digits with its leading +, or null when it has fewer than 7 digits. */
export function cleanPhone(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return raw.startsWith('+') || raw.startsWith('00') ? `+${digits.replace(/^00/, '')}` : digits;
}

/** Whether a whole text is a phone number (a chat that has no saved name shows its number). */
export const looksLikePhone = (text: string) => /^\+?[\d\s().-]{7,20}$/.test(text.trim()) && !!cleanPhone(text);

/** A handle's value as compared: GitHub and X logins ignore case and a leading @; ids are kept as they are. */
export function cleanHandle(kind: HandleKind, value: string | null | undefined): string | null {
  let handle = (value ?? '').trim();
  if (!handle) return null;
  if (kind === 'github' || kind === 'x' || kind === 'linkedin') handle = handle.replace(/^@/, '').toLowerCase();
  if (kind === 'whatsapp') return cleanPhone(handle);
  return handle.slice(0, 200);
}

export const handleKey = (handle: Pick<PersonHandle, 'kind' | 'value'>) => `${handle.kind}:${handle.value}`;

/** The key of an alias or a candidate: its workspace (or `*` for everywhere / none) and its name key. */
export const scopedKey = (workspaceId: string | null, key: string) => `${workspaceId ?? '*'}|${key}`;

/** A handle counts in a workspace when it was saved for everywhere or for that workspace. */
export const handleFits = (handle: PersonHandle, workspaceId: string | null) =>
  handle.workspaceId === null || handle.workspaceId === workspaceId;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `prefix` + 10 random base32 characters. */
export function newPeopleId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return prefix + Array.from(bytes, byte => BASE32[byte % 32]).join('');
}
