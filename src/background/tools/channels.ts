/**
 * Where each tool can be used. A chat runs for one origin (the panel, WhatsApp, an agent, a routine or the daily
 * brief); voice has its own tool list. One place says which of those carry which tool, so the generated table
 * (docs/tools.md) and the lists a channel sends cannot disagree.
 */

export type ToolChannel = 'panel' | 'voice' | 'whatsapp' | 'agent' | 'routine';

export const CHAT_CHANNELS: readonly ToolChannel[] = ['panel', 'whatsapp', 'agent', 'routine'];

export const ALL_CHANNELS: readonly ToolChannel[] = ['panel', 'voice', 'whatsapp', 'agent', 'routine'];

// Chat actions a channel does not carry. Empty until the per-channel lists (#134)
const NOT_IN_CHAT: Partial<Record<ToolChannel, ReadonlySet<string>>> = {};
const NOT_IN_VOICE: ReadonlySet<string> = new Set();

/** The channels that can call a chat action. */
export function chatActionChannels(name: string): ToolChannel[] {
  return CHAT_CHANNELS.filter(channel => !NOT_IN_CHAT[channel]?.has(name));
}

/** The channels that can call a voice tool. */
export function voiceToolChannels(name: string): ToolChannel[] {
  return NOT_IN_VOICE.has(name) ? [] : ['voice'];
}
