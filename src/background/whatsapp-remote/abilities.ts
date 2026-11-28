import type { WhatsAppAbility } from '@src/shared/lib/protocol/companion';

/**
 * What Ava can and cannot do on WhatsApp, in words for the chat's instructions (#202). The list itself comes from
 * Ava Brain's running driver (WhatsAppStatus.abilities), never from a prompt: when a driver gains a method, the
 * ability shows up here as "can", and its line leaves "not yet" by itself. Only the words are kept by hand.
 */

export const ABILITY_WORDS: Record<WhatsAppAbility, string> = {
  send_text: 'answer in text',
  send_voice:
    'answer with a voice note in your voice (he can say "reply with voice notes" or "answer in text" to switch)',
  send_image: 'send pictures (made from a description, or a screenshot of a page)',
  send_video: 'send short videos',
  send_document: 'send files from this computer',
  react: 'react to their message with an emoji',
  edit: 'change your last message ("change that to …")',
  delete: 'delete your last message ("delete that")',
  presence: 'show "typing…" or "recording…" while you work',
  read_voice: 'understand their voice notes',
  read_photo: 'look at photos they send',
  read_document: 'read documents they send (kept in the knowledge base)',
  read_link: 'open and read links they send',
  groups: 'take part in WhatsApp groups (answer when mentioned)',
  other_people: 'talk with people other than the owner who joined with a code',
  message_others: 'message other people for the owner, after the owner says OK',
};

// What is being built, and where: said as "not yet, it's coming" when asked
export const NOT_YET_ISSUE: Partial<Record<WhatsAppAbility, number>> = {
  send_image: 204,
  send_video: 204,
  send_document: 204,
  groups: 20,
  other_people: 205,
  message_others: 206,
};

const ORDER = Object.keys(ABILITY_WORDS) as WhatsAppAbility[];

/**
 * The WhatsApp chat's section: what works there now and what does not yet. `abilities` null means Ava Brain could
 * not be asked (the chat then only learns that it cannot tell).
 */
export function whatsappAbilitiesSection(abilities: readonly WhatsAppAbility[] | null): string {
  if (abilities === null || abilities.length === 0) {
    return `
# ON WHATSAPP:
- Ava Brain did not say what works on WhatsApp right now (it may be closed or not linked). Do not promise anything WhatsApp-specific (voice notes, pictures, files); answer in text.
`;
  }
  const has = new Set(abilities);
  const can = ORDER.filter(id => has.has(id)).map(id => ABILITY_WORDS[id]);
  const notYet = ORDER.filter(id => !has.has(id)).map(id => {
    const issue = NOT_YET_ISSUE[id];
    return `${ABILITY_WORDS[id]}${issue ? ' (being built)' : ''}`;
  });
  return `
# ON WHATSAPP:
- From Ava Brain's WhatsApp connection right now. Everything in "WHAT YOU CAN DO" also works from here (browser tasks on this computer, tasks, memory…), except what needs the user at the screen.
- On WhatsApp you can: ${can.join('; ')}.
${notYet.length ? `- Not possible on WhatsApp yet: ${notYet.join('; ')}. Asked for one of these ("can you send me a picture?"), say plainly it is not possible yet${notYet.some(line => line.endsWith('(being built)')) ? ' and that it is coming' : ''}, and offer what works today instead. Never pretend to do it.\n` : ''}`;
}
