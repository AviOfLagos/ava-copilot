import type { ThreadRecord } from '@extension/storage';

/**
 * Where each tool can be used. A chat runs for one origin (the panel, WhatsApp, an agent, a routine or the daily
 * brief); voice has its own tool list. One place says which of those carry which tool, so the generated table
 * (docs/tools.md) and the lists a channel sends cannot disagree.
 *
 * The panel keeps everything. WhatsApp, agents and routines lose what needs the user at the screen and the growth
 * team's tools when the chat's workspace has no product.
 */

export type ToolChannel = 'panel' | 'voice' | 'whatsapp' | 'agent' | 'routine';

export const CHAT_CHANNELS: readonly ToolChannel[] = ['panel', 'whatsapp', 'agent', 'routine'];

export const ALL_CHANNELS: readonly ToolChannel[] = ['panel', 'voice', 'whatsapp', 'agent', 'routine'];

/** The channel a chat runs in, from the thread's origin. A voice-started chat is read in the panel. */
export function channelOfOrigin(origin: ThreadRecord['origin'] | string | undefined): ToolChannel {
  switch (origin) {
    case 'whatsapp':
      return 'whatsapp';
    case 'agent':
      return 'agent';
    case 'workflow':
    case 'brief':
      return 'routine';
    default:
      return 'panel';
  }
}

// What only makes sense with the user at the screen, or speaks into a live call. WhatsApp has the user on a phone;
// an agent or a routine has no one waiting. The gate still decides every action that changes something.
const NEEDS_THE_SCREEN: ReadonlySet<string> = new Set([
  'open_place',
  'check_audio',
  'check_model',
  'switch_model',
  'say_in_meeting',
  'stop_speaking_in_call',
  'leave_call',
  'end_call_for_everyone',
  'remove_ava_from_call',
  'join_next_meeting',
  'start_meeting_notes',
  'stop_meeting_notes',
  'ask_meeting',
]);

// The growth team's chat actions (docs/growth-team.md). Without a product to act for they only answer "no product".
// update_product_profile is left out: it is how a product gets set.
export const GROWTH_TOOLS: ReadonlySet<string> = new Set([
  'add_channel',
  'draft_follow_up',
  'draft_outreach',
  'make_link',
  'metrics_query',
  'post_results',
  'propose_channel_test',
  'queue_for_approval',
  'rank_channels',
  'read_feedback',
  'request_beta_grant',
  'request_spend',
  'sort_feedback',
  'stop_contact',
]);

const AWAY_FROM_THE_SCREEN: ReadonlySet<ToolChannel> = new Set(['whatsapp', 'agent', 'routine']);

export interface ChannelFacts {
  // Whether the chat's workspace has a product set
  hasProduct: boolean;
}

/** Whether a chat in this channel is offered this action. */
export function chatActionAllowed(
  name: string,
  channel: ToolChannel,
  facts: ChannelFacts = { hasProduct: true },
): boolean {
  if (!AWAY_FROM_THE_SCREEN.has(channel)) return true;
  if (NEEDS_THE_SCREEN.has(name)) return false;
  return facts.hasProduct || !GROWTH_TOOLS.has(name);
}

/** The actions a chat in this channel is offered, in their order. */
export function actionsForChannel<T extends { name(): string }>(
  actions: T[],
  channel: ToolChannel,
  facts: ChannelFacts = { hasProduct: true },
): T[] {
  return actions.filter(action => chatActionAllowed(action.name(), channel, facts));
}

/** The channels that can call a chat action (a growth tool with a product set counts as allowed). */
export function chatActionChannels(name: string): ToolChannel[] {
  return CHAT_CHANNELS.filter(channel => chatActionAllowed(name, channel));
}

// Voice tools the voice list does not carry. None in this version: voice keeps all of its tools.
const NOT_IN_VOICE: ReadonlySet<string> = new Set();

/** The voice tools the voice assistant is offered. */
export function voiceToolAllowed(name: string): boolean {
  return !NOT_IN_VOICE.has(name);
}

/** The channels that can call a voice tool. */
export function voiceToolChannels(name: string): ToolChannel[] {
  return voiceToolAllowed(name) ? ['voice'] : [];
}
