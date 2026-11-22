import type { ThreadRecord } from '@extension/storage';

/**
 * What a chat may do, by who started it. One place for the rules, so features do not keep lists of their own:
 * - an agent's or a routine's chat runs with nobody watching;
 * - the brief's chat is made by the copilot, not asked for;
 * - a chat from WhatsApp holds the user's own words, but he is away from the computer: the click in the panel is
 *   the only approval, nothing is said aloud or in a call for him, and nothing is configured from there.
 */

type Origin = NonNullable<ThreadRecord['origin']>;
type Chat = Pick<ThreadRecord, 'origin'> | undefined;

// Started by something other than the user
const NOT_THE_USER: ReadonlySet<Origin> = new Set(['agent', 'workflow', 'brief']);
// The user, but not at the computer
const REMOTE: ReadonlySet<Origin> = new Set(['whatsapp']);
// Every commit waits for the click, whatever the confirm settings say
export const ALWAYS_ASK_ORIGINS: ReadonlySet<Origin> = new Set(['agent', 'workflow', 'whatsapp']);

const has = (set: ReadonlySet<Origin>, chat: Chat) => Boolean(chat?.origin && set.has(chat.origin));

/** Whether a chat always asks before it commits. A chat that cannot be read counts as one nobody watches. */
export function alwaysAsks(chat: Chat): boolean {
  return !chat || has(ALWAYS_ASK_ORIGINS, chat);
}

// Chats that are not the user typing at the computer. Whether they read outside content is only known when the code that
// started them said so (`tainted`); when it did not, they count as having read some.
const MAY_READ_OUTSIDE: ReadonlySet<Origin> = new Set(['agent', 'workflow', 'brief', 'whatsapp']);

/**
 * Whether a saved "Allow every time" rule may answer for a chat. Never for a run that read content from outside:
 * a stranger's message or a page must not be able to unlock an approval. Fails closed: a chat that cannot be read, or
 * an agent's, routine's, brief's or WhatsApp chat whose starter did not say it is clean, gets no rule.
 */
export function rulesMayAnswer(chat: Pick<ThreadRecord, 'origin' | 'tainted'> | undefined): boolean {
  if (!chat || chat.tainted === true) return false;
  if (chat.origin && MAY_READ_OUTSIDE.has(chat.origin)) return chat.tainted === false;
  return true;
}

/** The user started it from somewhere away from the computer (WhatsApp). */
export function isRemoteChat(chat: Chat): boolean {
  return has(REMOTE, chat);
}

/**
 * The user is in this chat at the computer (typed or spoken): it may hand work over, speak in a call, read aloud,
 * or open a sign-in for him.
 */
export function userAtComputer(chat: Chat): boolean {
  return Boolean(chat) && !has(NOT_THE_USER, chat) && !has(REMOTE, chat);
}

/**
 * Why a chat may not create, change or delete configuration (agents, routines, connectors), or null when it may:
 * only the user's own chats at the computer do. A chat that cannot be read is treated as the user's (the panel
 * confirms every draft anyway).
 */
export function configRefusal(chat: Chat, what: string): string | null {
  if (chat?.origin === 'agent' || chat?.origin === 'workflow') {
    return `${what} can only be created, changed or run from a chat with the user, not by a routine or an agent.`;
  }
  if (isRemoteChat(chat)) return `${what} can only be created or changed from the browser, not from WhatsApp.`;
  return null;
}

/** Why a chat may not run an existing agent or routine, or null when it may (their commits wait for the click). */
export function runRefusal(chat: Chat, what: string): string | null {
  if (chat?.origin === 'agent' || chat?.origin === 'workflow') {
    return `${what} can only be created, changed or run from a chat with the user, not by a routine or an agent.`;
  }
  return null;
}
