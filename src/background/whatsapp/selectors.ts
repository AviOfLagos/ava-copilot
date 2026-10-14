import { builtinSkills, skillStore } from '@extension/storage';

/**
 * Where things are on WhatsApp Web's page lives in the `whatsapp-web` skill, not in code: a fenced
 * ```selectors block of `key: selector || selector` lines. A user who edits the skill (WhatsApp changed its
 * page) changes what this feature looks for, with no new release. Keys the user's copy leaves out fall back to
 * the built-in skill's.
 */

export const WHATSAPP_SKILL_ID = 'whatsapp-web';

export type SelectorKey =
  | 'chatList'
  | 'chatRow'
  | 'rowTitle'
  | 'rowPreview'
  | 'rowUnread'
  | 'searchBox'
  | 'chatHeader'
  | 'message'
  | 'messageText'
  | 'outgoing'
  | 'composer'
  | 'sendButton'
  | 'invalidNumber'
  | 'loggedOut'
  | 'mediaCaption'
  | 'mediaSend';

// Each key: the selectors to try, in order
export type WhatsappSelectors = Record<string, string[]>;

/** Reads the ```selectors block of a skill body. Lines that are not `key: value` are ignored. */
export function parseSelectors(body: string): WhatsappSelectors {
  const block = /```selectors\s*\n([\s\S]*?)```/.exec(body);
  const out: WhatsappSelectors = {};
  if (!block) return out;
  for (const line of block[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (!/^\w+$/.test(key)) continue;
    const values = line
      .slice(colon + 1)
      .split('||')
      .map(value => value.trim())
      .filter(Boolean);
    if (values.length) out[key] = values;
  }
  return out;
}

/** The user's copy of the skill over the built-in one, key by key. */
export function mergeSelectors(own: WhatsappSelectors, builtin: WhatsappSelectors): WhatsappSelectors {
  return { ...builtin, ...own };
}

export async function whatsappSelectors(): Promise<WhatsappSelectors> {
  const builtin = builtinSkills().find(skill => skill.id === WHATSAPP_SKILL_ID);
  const builtinSelectors = builtin ? parseSelectors(builtin.body) : {};
  const all = await skillStore.all().catch(() => []);
  const own = all.find(skill => skill.id === WHATSAPP_SKILL_ID && skill.source !== 'builtin');
  return mergeSelectors(own ? parseSelectors(own.body) : {}, builtinSelectors);
}
