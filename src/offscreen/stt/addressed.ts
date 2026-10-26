/**
 * Whether what the microphone heard is a turn for the copilot, and when it is finished. A pause in the middle of a
 * sentence is not the end of the turn, and words from across the room (a radio, a TV, someone else) are not the
 * user talking to the copilot.
 *
 * - Fragments heard close together are one turn. Words that stop mid-clause ("so that's", "I'm always looking,
 *   I'm") wait longer for the rest.
 * - After a lull (nothing said either way for LULL_MS), only words that call the copilot by name start a turn.
 * - Words much quieter than the user's own voice in this conversation are someone further away: they too have to
 *   call the copilot by name.
 * - A voiceprint (Ambient A2, docs/ambient-plan.md) can say whose voice it was; anyone but the user has to use the
 *   name. Until then every voice is 'unknown'.
 */

export type SpeakerLabel = 'me' | 'other' | 'media' | 'unknown';

export interface HeardFragment {
  text: string;
  // How loud its voiced sound was (see speechLevel)
  level: number;
  // When its speech started, on the performance.now() clock
  startedAt: number;
  speaker: SpeakerLabel;
}

// This long with nothing said either way, and the conversation has lapsed: the next turn has to use the name
export const LULL_MS = 25_000;
// Before the user's first turn the lull is longer: they started the conversation, and may take a while to begin
export const OPENING_LULL_MS = 60_000;
// Quieter than this share of the user's usual level is someone further from the microphone than the user
export const FAINT_RATIO = 0.35;
// The user's usual level is the median of this many recent turns
const LEVELS_KEPT = 8;
// Extra quiet, after the speech gate closed, that words stopping mid-clause wait for the rest
export const UNFINISHED_WAIT_MS = 1000;

// Words a sentence seldom ends on: what comes after them is still to be said. Waiting wrongly costs a second;
// not waiting cuts the user off, so the list leans long (some questions end on "on" or "for")
const OPEN_ENDINGS = new Set(
  (
    'and but or because cause cuz which whose if when while than like as um uh er ' +
    'to of in on at for with from about into onto by over under through between without ' +
    'a an the my your his our their its some any every ' +
    "i i'm im you're we're they're he's she's it's that's there's what's who's let's i'll i'd " +
    "doesn't didn't gonna wanna gotta just very"
  ).split(' '),
);

// What recognisers write for "Ava" besides "ava"
const AVA_SOUNDALIKES = ['ava', 'eva', 'avah', 'ayva'];

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .map(word => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean);

/** The words that call the copilot: its name's first word, and what recognisers make of "Ava". */
export function callWords(assistantName = 'Ava'): string[] {
  const first = wordsOf(assistantName)[0] ?? 'ava';
  return first === 'ava' ? AVA_SOUNDALIKES : [first];
}

/** Whether the words call the copilot by name ("Ava, what's next", "hey Eva"). */
export function namesAssistant(text: string, names: string[]): boolean {
  // "Ava's" calls her too
  return wordsOf(text).some(word => names.includes(word.replace(/'s$/, '')));
}

/** Whether the words stop mid-clause, or are only the copilot's name: the rest of the turn is still coming. */
export function soundsUnfinished(text: string, names: string[] = []): boolean {
  const trimmed = text.trim();
  if (/(,|\.\.\.|…|-|–|—)$/.test(trimmed)) return true;
  const words = wordsOf(trimmed);
  if (!words.length) return false;
  // "Ava." or "Hey Ava" on its own: the question follows
  if (words.every(word => word === 'hey' || word === 'hi' || word === 'ok' || names.includes(word))) return true;
  // A question mark ends a turn whatever the last word
  if (trimmed.endsWith('?')) return false;
  const last = words[words.length - 1];
  return OPEN_ENDINGS.has(last) || OPEN_ENDINGS.has(last.replace(/'/g, ''));
}

export type Verdict = { ok: true } | { ok: false; reason: 'lull' | 'faint' | 'other' };

/** Decides whether a finished turn is the user talking to the copilot, and learns how loud the user is. */
export class Addressee {
  private lastExchange: number;
  private levels: number[] = [];
  private turns = 0;

  constructor(
    private names: string[],
    now: number,
  ) {
    this.lastExchange = now;
  }

  /** Something passed between them now (the copilot spoke, the user typed): the conversation is going on. */
  exchanged(now: number): void {
    this.lastExchange = Math.max(this.lastExchange, now);
  }

  rename(names: string[]): void {
    this.names = names;
  }

  /** The level below which a voice counts as far away, or 0 before the user's own level is known. */
  faintBelow(): number {
    if (!this.levels.length) return 0;
    const sorted = [...this.levels].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] * FAINT_RATIO;
  }

  /** Whether these fragments, one turn together, are for the copilot; a turn that is counts as an exchange. */
  judge(fragments: HeardFragment[], now: number): Verdict {
    if (!fragments.length) return { ok: false, reason: 'lull' };
    const text = fragments.map(fragment => fragment.text).join(' ');
    const level = Math.max(...fragments.map(fragment => fragment.level));
    const started = Math.min(...fragments.map(fragment => fragment.startedAt));
    const named = namesAssistant(text, this.names);
    let verdict: Verdict = { ok: true };
    if (!named) {
      if (fragments.some(fragment => fragment.speaker === 'other' || fragment.speaker === 'media'))
        verdict = { ok: false, reason: 'other' };
      else if (started - this.lastExchange > (this.turns ? LULL_MS : OPENING_LULL_MS))
        verdict = { ok: false, reason: 'lull' };
      else if (level < this.faintBelow()) verdict = { ok: false, reason: 'faint' };
    }
    if (!verdict.ok) return verdict;
    this.turns++;
    this.lastExchange = Math.max(this.lastExchange, now);
    // Only a voice near the microphone teaches the user's level: a name called from across the room does not
    if (level >= this.faintBelow()) {
      this.levels.push(level);
      if (this.levels.length > LEVELS_KEPT) this.levels.shift();
    }
    return verdict;
  }
}
