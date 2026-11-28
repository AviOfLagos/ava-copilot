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
// Every commit waits for the click, whatever the confirm settings say. The desktop app's chat too, for now: its words
// come through Ava Brain's queue from any process holding the desktop token, not from the panel itself
export const ALWAYS_ASK_ORIGINS: ReadonlySet<Origin> = new Set(['agent', 'workflow', 'whatsapp', 'desktop']);

const has = (set: ReadonlySet<Origin>, chat: Chat) => Boolean(chat?.origin && set.has(chat.origin));

/** Whether a chat always asks before it commits. A chat that cannot be read counts as one nobody watches. */
export function alwaysAsks(chat: Chat): boolean {
  return !chat || has(ALWAYS_ASK_ORIGINS, chat);
}

// Chats that are not the user typing at the computer. Whether they read outside content is only known when the code
// that started them said so (`tainted: false`); when it did not, they count as having read some.
// The desktop app's chat counts too, for now (D1): its words come through Ava Brain's queue, not the panel itself
const MAY_READ_OUTSIDE: ReadonlySet<Origin> = new Set(['agent', 'workflow', 'brief', 'whatsapp', 'desktop']);

/**
 * Whether a saved "Allow every time" rule of `kind` may answer for a chat, and whether its card may offer one. The one
 * policy every gate uses. Fails closed, because classifying an action by its label always misses some (a "Reply",
 * an RSVP, a contact form's Submit can all come out as another kind).
 *
 * - A chat that cannot be read: no.
 * - An agent's, routine's, brief's or WhatsApp chat: only when its starter said it is clean (`tainted: false`).
 * - The user's own chat (user, voice): only while it has not read outside content (a web page, an email, a message
 *   from someone else); after that, no rule of any kind. `kind` is kept so a narrower policy (rules by recipient,
 *   epic #169) can come back later.
 */
export function rulesMayAnswer(chat: Pick<ThreadRecord, 'origin' | 'tainted'> | undefined, kind?: string): boolean {
  if (!chat) return false;
  if (chat.origin && MAY_READ_OUTSIDE.has(chat.origin)) return chat.tainted === false;
  void kind;
  return chat.tainted !== true;
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
  // Until the agent loop lives in the app (docs/desktop-app.md, D7), configuration is changed in the browser only
  if (chat?.origin === 'desktop') {
    return `${what} can only be created or changed from the browser's Ava panel, not from the desktop app yet.`;
  }
  return null;
}

/** Why a chat may not run an existing agent or routine, or null when it may (their commits wait for the click). */
export function runRefusal(chat: Chat, what: string): string | null {
  if (chat?.origin === 'agent' || chat?.origin === 'workflow') {
    return `${what} can only be created, changed or run from a chat with the user, not by a routine or an agent.`;
  }
  return null;
}
