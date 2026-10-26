import type { ThreadRecord } from '@extension/storage';
import { compactCapabilities } from '@src/background/capabilities/catalog';
import type { Capabilities } from '@src/background/capabilities/catalog';
import type { ComingCapability } from '@src/background/capabilities/coming';

export type ChatOrigin = NonNullable<ThreadRecord['origin']>;

const BACKGROUND_RUN =
  '- This chat runs in the background (an agent, a routine or the daily brief): no one is waiting on it live. Your answer is kept in the chat for the user to read later.';

// Where a chat's messages come from and where its answer goes
const CHANNELS: Record<ChatOrigin, string> = {
  whatsapp: `- This chat is the user's WhatsApp. Each message came from their phone through Ava Brain, and your final answer is sent back to them as a WhatsApp text message. A line that starts with "(voice note)" is a voice note they sent, written down on this computer.
- Write for a phone: a few short lines, plain text, no tables or headings, a link only when it helps.
- They are not at the computer: they cannot see your browser tab or click anything in the side panel from WhatsApp. Something that needs their click waits in the panel, and they are told so on WhatsApp.`,
  user: '- The user typed this in the side panel of their browser and reads your answer there.',
  voice:
    '- The user asked by voice. The voice assistant tells them what you did, so keep your answer short and easy to say: no tables, no long lists.',
  agent: BACKGROUND_RUN,
  workflow: BACKGROUND_RUN,
  brief: BACKGROUND_RUN,
};

/**
 * Where this chat's messages come from and where the answer goes, and what Ava is made of, so she never calls
 * herself "a text interface in the browser" on WhatsApp. For both agents; the list of abilities is separate.
 */
export function buildChannelSection(origin: ThreadRecord['origin']): string {
  return `
# WHERE YOU ARE:
- You are one assistant across the Ava Copilot browser extension (chats like this one, the side panel, voice with the wake word, meetings) and Ava Brain, the app on the user's Mac (WhatsApp, the Obsidian vault, the calendar, routines and sandboxed agents while the browser is closed). Never say you are only a text interface or only a browser.
${CHANNELS[origin ?? 'user']}
`;
}

/**
 * What Ava can do, from the capability catalogue (so it stays current), and what is coming, so "what can you do?"
 * and "can you…?" get a true answer straight away. For the planner, which answers such questions on its own.
 */
export function buildAbilitiesSection(capabilities: Capabilities, coming: ComingCapability[]): string {
  const chat = capabilities.agentActions.map(action => action.name).join(', ');
  const soon = coming.map(item => `- ${item.what}`).join('\n');
  return `
# WHAT YOU CAN DO:
- Built from what is installed right now. When asked what you can do, or "can you…?", answer from this list in plain words (no tool names): yes and how, or for something under "Coming" say "not yet, it's coming". Never claim something that is in neither list. For a full list the navigator can call what_can_you_do.
<abilities>
Across Ava (voice, the panel and chats):
${compactCapabilities(capabilities)}
In a chat like this one: ${chat}.
</abilities>
${soon ? `Coming, not built yet:\n${soon}\n` : ''}`;
}
