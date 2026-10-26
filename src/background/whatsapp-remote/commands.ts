/**
 * What he says on WhatsApp about Ava's own messages, read here rather than by a model: "delete that", "change that
 * to …", "react 🔥 to that". Only a message that is nothing but the command counts, typed or said in a voice note,
 * so anything longer still goes to the chat. "That" is the message he quoted, or else her last one.
 */

export type WhatsAppCommand = { kind: 'delete' } | { kind: 'edit'; text: string } | { kind: 'react'; emoji: string };

// An emoji or a few: pictographs with their skin tones, joiners and variation selectors, and flags
const EMOJI =
  '(?:(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator})(?:\\u{FE0F}|\\p{Emoji_Modifier}|\\u{200D}\\p{Extended_Pictographic})*)+';
// A voice note says the emoji's name
const NAMED: Record<string, string> = {
  'thumbs up': '👍',
  thumbsup: '👍',
  like: '👍',
  fire: '🔥',
  heart: '❤️',
  love: '❤️',
  laugh: '😂',
  laughing: '😂',
  lol: '😂',
  clap: '👏',
  check: '✅',
  tick: '✅',
  done: '✅',
  eyes: '👀',
  pray: '🙏',
  thanks: '🙏',
  hundred: '💯',
  '100': '💯',
  party: '🎉',
  celebrate: '🎉',
};
const THAT = '(?:that|this|it|that one|this one|your (?:last )?(?:message|one|reply|answer)|the last (?:one|message))';
const POLITE = '(?:(?:please|pls|ava|hey ava)[,\\s]+)?';
const END = '(?:[,\\s]+please)?[\\s.!]*';

const DELETE = new RegExp(`^${POLITE}(?:delete|remove|unsend|take back)\\s+${THAT}${END}$`, 'iu');
const EDIT = new RegExp(`^${POLITE}(?:edit|change|correct|fix)\\s+${THAT}\\s+to\\s*[:\\-–]?\\s*([\\s\\S]+)$`, 'iu');
const NAMES = Object.keys(NAMED).join('|');
const REACT = new RegExp(
  `^${POLITE}react\\s+(?:with\\s+(?:an?\\s+)?)?(${EMOJI}|${NAMES})(?:\\s+emoji)?(?:\\s+(?:to|on)\\s+${THAT})?${END}$`,
  'iu',
);
const REACT_TO = new RegExp(
  `^${POLITE}react\\s+(?:to|on)\\s+${THAT}\\s+with\\s+(?:an?\\s+)?(${EMOJI}|${NAMES})(?:\\s+emoji)?${END}$`,
  'iu',
);

/** The command a whole message is, or null when it is anything else. */
export function commandOf(text: string): WhatsAppCommand | null {
  const words = text.trim();
  if (!words || words.length > 4000) return null;
  if (DELETE.test(words)) return { kind: 'delete' };
  const react = REACT.exec(words) ?? REACT_TO.exec(words);
  if (react) {
    const emoji = NAMED[react[1].toLowerCase()] ?? react[1];
    return { kind: 'react', emoji };
  }
  const edit = EDIT.exec(words);
  if (edit) {
    const next = edit[1]
      .trim()
      .replace(/^["“'‘]|["”'’]$/g, '')
      .trim();
    return next ? { kind: 'edit', text: next } : null;
  }
  return null;
}
