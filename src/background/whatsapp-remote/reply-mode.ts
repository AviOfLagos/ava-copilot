/**
 * "Reply with voice notes from now on", "answer in text" (#203): the owner says how Ava answers him on WhatsApp,
 * typed or in a voice note, and it sticks until he says otherwise. Read here, in code, never by a model. The
 * instruction may open or close a longer message ("answer in text: what's on today?"); what is left still goes to
 * the chat. Anything that only mentions voice notes ("send Ada a voice note") is not an instruction.
 */

export type ReplyMode = 'voice' | 'text';

export interface ReplyModeInstruction {
  mode: ReplyMode;
  // The rest of his message, without the instruction (empty when it was all of it)
  rest: string;
}

const POLITE = "(?:(?:please|pls|ava|hey ava|ok(?:ay)?|and|i want you to|i'd like you to|i would like you to)[,\\s]+)*";
// "Can you reply with voice notes?" asks for a way of answering; "can you send voice notes?" asks what she can do
const ASK = '(?:(?:can|could|would|will)\\s+you\\s+)?';
const ME = '(?:(?:to\\s+)?me\\s+)?';
const FROM_NOW =
  '(?:[,\\s]+(?:from now on|going forward|for now|from here on|always|again|instead|please|only|pls|thanks|thank you))*';
const REPLY = '(?:reply|answer|respond|talk|speak|get back)';
const VOICE_NOTES = '(?:an?\\s+)?(?:voice(?:\\s*notes?|\\s*messages?|\\s*memos?)?|audio(?:\\s*notes?|\\s*messages?)?)';
// Plural, no article: "send me voice notes" is a way of answering, "send me a voice note about…" is one request
const VOICE_PLURAL = '(?:voice\\s*(?:notes|messages|memos)|audio\\s*(?:notes|messages))';
const TEXT_WORDS = '(?:text(?:\\s*messages?)?|words|writing|chat)';
const SWITCH = "(?:switch|change|go|move)\\s+(?:back\\s+)?to|i\\s+prefer|i'd\\s+prefer|i\\s+would\\s+prefer";
// "Reply with text, not voice notes": the other half says the same thing
const NOT_OTHER = `(?:[,\\s]+(?:and\\s+)?not\\s+(?:with\\s+|in\\s+|by\\s+)?(?:${VOICE_NOTES}|${TEXT_WORDS}))?`;

// May open or close a longer message
const VOICE = [
  `${ASK}${REPLY}\\s+${ME}(?:with|in|by|using|via)\\s+${VOICE_NOTES}`,
  `(?:${SWITCH})\\s+${VOICE_NOTES}`,
  `(?:send|use)\\s+${ME}${VOICE_PLURAL}\\s+(?:from now on|going forward|always|instead|only)`,
];
const TEXT = [
  `${ASK}${REPLY}\\s+${ME}(?:with|in|by|using|via)\\s+${TEXT_WORDS}`,
  `(?:${SWITCH})\\s+${TEXT_WORDS}`,
  `(?:type|write)\\s+(?:your\\s+)?(?:replies|answers)`,
  `(?:no|stop(?:\\s+(?:the|sending))?)\\s+(?:more\\s+)?voice\\s*notes?`,
];
// Only when they are the whole message: "text me the address" and "send me a voice note about…" are requests
const VOICE_WHOLE = [`(?:send|use)\\s+${ME}${VOICE_PLURAL}`, `${VOICE_PLURAL}\\s+(?:from now on|please|only)`];
const TEXT_WHOLE = ['(?:just\\s+)?text\\s+me(?:\\s+back)?'];

const END = `${NOT_OTHER}${FROM_NOW}[\\s.!?]*`;
const pattern = (alternatives: string[], where: 'start' | 'end' | 'whole') => {
  const body = `(?:${alternatives.join('|')})`;
  if (where === 'whole') return new RegExp(`^\\s*${POLITE}${body}${END}$`, 'iu');
  // Opening: a mark must part it from his question; closing: it is its own sentence
  return where === 'start'
    ? new RegExp(`^\\s*${POLITE}${body}${END}(?:[:,;.!?\\-–—]\\s*|$)`, 'iu')
    : new RegExp(`(^|[.!?;]\\s*)${POLITE}${body}${END}$`, 'iu');
};
const VOICE_START = pattern(VOICE, 'start');
const VOICE_END = pattern(VOICE, 'end');
const TEXT_START = pattern(TEXT, 'start');
const TEXT_END = pattern(TEXT, 'end');
const VOICE_ALONE = pattern([...VOICE, ...VOICE_WHOLE], 'whole');
const TEXT_ALONE = pattern([...TEXT, ...TEXT_WHOLE], 'whole');

// "Send Ada a voice note" names someone else: never his own replies
const FOR_SOMEONE_ELSE = /^\s*(?:send|use)\s+(?!me\b|to\s+me\b)[a-z]+\s+(?:an?\s+)?voice/iu;

const tidy = (text: string) =>
  text
    .replace(/^[\s:,;.\-–—]+/, '')
    .replace(/[\s,;\-–—]+$/, '')
    .trim();

/** The reply mode his message sets, and what is left of it, or null when it sets none. */
export function replyModeOf(text: string): ReplyModeInstruction | null {
  const words = text.trim();
  if (!words || words.length > 4000 || FOR_SOMEONE_ELSE.test(words)) return null;
  for (const [mode, alone, start, end] of [
    ['text', TEXT_ALONE, TEXT_START, TEXT_END],
    ['voice', VOICE_ALONE, VOICE_START, VOICE_END],
  ] as const) {
    if (alone.test(words)) return { mode, rest: '' };
    const opening = start.exec(words);
    if (opening) return { mode, rest: tidy(words.slice(opening[0].length)) };
    const closing = end.exec(words);
    // The question mark or full stop before it stays with his words
    if (closing) return { mode, rest: tidy(words.slice(0, closing.index) + closing[1].trim()) };
  }
  return null;
}

/**
 * Whether this answer goes as a voice note. His own instruction wins; without one, the settings decide as before
 * (a voice note answered by one, typed messages too when he chose that).
 */
export function answersInVoice(
  mode: ReplyMode | null,
  settings: { voiceReplies: boolean; voiceForText: boolean },
  turnHadVoice: boolean,
): boolean {
  if (mode === 'voice') return true;
  if (mode === 'text') return false;
  return settings.voiceReplies && (turnHadVoice || settings.voiceForText);
}
