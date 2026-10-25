/**
 * The few spoken switches Ava obeys while she only listens, matched word for word on the device: no model hears
 * ambient words, and nothing else in them is ever an order. Switches that change what she does need her name
 * first ("Ava, just listen"); going off the record does not, so "let's go off the record" protects a talk even
 * when nobody thought to address her. The offscreen document imports this too, so it stays free of imports.
 */

export type AmbientSwitch =
  | { kind: 'listen' }
  | { kind: 'companion' }
  | { kind: 'quiet' }
  | { kind: 'off_record' }
  | { kind: 'on_record' }
  | { kind: 'forget'; minutes: number };

// What recognisers commonly write for "Ava"
const AVA_ALIASES = ['ava', 'eva'];
// "Forget that" with no span forgets this much
export const FORGET_THAT_MINUTES = 2;
const MAX_FORGET_MINUTES = 24 * 60;

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  'forty five': 45,
  fifty: 50,
  sixty: 60,
  few: 5,
  'a few': 5,
  'a couple of': 2,
  'couple of': 2,
  'half an': 30,
};

/** Lower case, letters, digits and apostrophes only, single spaces. */
export function plainSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ways the assistant's name may open a switch: its words, and for the default name what recognisers make of it. */
function namePattern(nameWords: string[]): string {
  const name = nameWords.map(word => plainSpeech(word)).filter(Boolean);
  const spoken = name.length ? [name.join(' ')] : [];
  if (!name.length || (name.length === 1 && name[0] === 'ava')) spoken.push(...AVA_ALIASES);
  return `(?:(?:hey|ok|okay) )?(?:${[...new Set(spoken)].map(escape).join('|')})`;
}

/** Minutes in "the last ten minutes", "the last 5 minutes", "the last hour", "the last half an hour". */
function spanMinutes(span: string): number | null {
  const hour = span.match(/^(?:(\d+|[a-z ]+?) )?hours?$/);
  if (hour) {
    if (!hour[1]) return 60;
    if (hour[1] === 'half an') return 30;
    const count = /^\d+$/.test(hour[1]) ? Number(hour[1]) : NUMBER_WORDS[hour[1]];
    return count ? count * 60 : null;
  }
  const minutes = span.match(/^(?:(\d+|[a-z ]+?) )?minutes?$/);
  if (!minutes) return null;
  if (!minutes[1]) return 1;
  const count = /^\d+$/.test(minutes[1]) ? Number(minutes[1]) : NUMBER_WORDS[minutes[1]];
  return count ?? null;
}

/** The switch an utterance is, or null for ordinary talk (by far the usual case). */
export function matchAmbientSwitch(text: string, nameWords: string[] = ['ava']): AmbientSwitch | null {
  const said = plainSpeech(text);
  if (!said) return null;
  const name = namePattern(nameWords);
  const named = (body: string) => new RegExp(`^${name} (?:${body})$`).test(said);

  // Off and back on the record: with or without the name, as the whole utterance
  const opener = `(?:${name} )?`;
  if (
    new RegExp(
      `^${opener}(?:(?:let's |lets )?(?:go |going )?|this is |we're |were |we are )?off the record(?: please)?$`,
    ).test(said)
  ) {
    return { kind: 'off_record' };
  }
  if (
    new RegExp(
      `^${opener}(?:(?:let's |lets |we're |were |we are )?(?:go |going )?)?back on the record(?: please)?$`,
    ).test(said)
  ) {
    return { kind: 'on_record' };
  }

  if (named('just listen|only listen|listen only|you can just listen|just listen please')) return { kind: 'listen' };
  if (named('feel free to chime in|you can chime in|chime in when you like|feel free to jump in')) {
    return { kind: 'companion' };
  }
  if (named('go quiet|stop listening|stop taking notes')) return { kind: 'quiet' };

  if (named('forget that|forget what i just said')) return { kind: 'forget', minutes: FORGET_THAT_MINUTES };
  const forget = said.match(new RegExp(`^${name} forget (?:the |what i said in the |everything from the )?last (.+)$`));
  if (forget) {
    const minutes = spanMinutes(forget[1]);
    if (minutes && minutes > 0) return { kind: 'forget', minutes: Math.min(minutes, MAX_FORGET_MINUTES) };
  }
  return null;
}
