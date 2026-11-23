/**
 * Notices when a voice conversation is not hearing the user well: the microphone stays near silent while it
 * listens (a muted or wrong mic), or what is recognised comes back empty or garbled several times in a row. It
 * says so once per conversation; the session then tells the user aloud and offers check_audio.
 */

export type HearingTrouble = 'mic-silent' | 'unclear-turns';

// Below this RMS level the microphone is taken as silent: a muted, unplugged or wrong device gives about 0, while
// a quiet room through noise suppression still sits above it
export const SILENT_LEVEL = 0.0001;
// Listening this long with the microphone silent throughout
export const SILENT_MS = 20_000;
// Recognised turns in a row that came back empty or garbled
export const UNCLEAR_TURNS = 3;

/** The System notice the session says when it is not hearing well: aloud, and in the panel as Ava's answer. */
export const HEARING_NOTICE =
  'I may not be hearing you well — check your mic, or I can switch how I listen. (After saying this, offer to run check_audio to test the mic.)';

/** Whether recognised text is empty or garbled: no word of two letters or more, or mostly symbols. */
export function unclearText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Recognisers write noise as "[BLANK_AUDIO]", "(music)", "..." or a lone letter
  if (/^[[(].*[\])]$/.test(trimmed)) return true;
  // One character of Chinese, Japanese or Korean is a word ("好", "是"), and so is a number
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}]/u.test(trimmed)) return false;
  const letters = trimmed.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 2) return true;
  return letters / trimmed.replace(/\s/g, '').length < 0.5;
}

// A gap between readings longer than this (the mic was held, the session reconnected) starts the stretch again
const READING_GAP_MS = 1000;

export class HearingWatch {
  private silentSince: number | null = null;
  private lastReading = Number.NEGATIVE_INFINITY;
  // Any sound above the floor this conversation: then the mic works, and quiet is the user thinking
  private everHeard = false;
  private unclear = 0;
  private warned = false;

  constructor(
    private readonly onTrouble: (trouble: HearingTrouble) => void,
    private readonly limits = { silentLevel: SILENT_LEVEL, silentMs: SILENT_MS, unclearTurns: UNCLEAR_TURNS },
  ) {}

  /**
   * A level reading of the microphone. `listening` is false while the answer plays: that time does not count, and
   * the silent stretch starts again (so does a gap in readings). Only a mic that has been silent the whole
   * conversation is taken as not working: once anything was heard, quiet is the user thinking.
   */
  level(rms: number, now: number, listening = true): void {
    if (this.warned || this.everHeard) return;
    const gap = now - this.lastReading > READING_GAP_MS;
    this.lastReading = now;
    if (rms > this.limits.silentLevel) {
      this.everHeard = true;
      return;
    }
    if (!listening || gap) {
      this.silentSince = listening ? now : null;
      return;
    }
    this.silentSince ??= now;
    if (now - this.silentSince >= this.limits.silentMs) this.warn('mic-silent');
  }

  /** What the recogniser made of one utterance: clear words reset the count, empty or garbled ones add to it. */
  recognised(text: string): void {
    if (this.warned) return;
    if (!unclearText(text)) {
      this.unclear = 0;
      return;
    }
    this.unclear++;
    if (this.unclear >= this.limits.unclearTurns) this.warn('unclear-turns');
  }

  get hasWarned(): boolean {
    return this.warned;
  }

  private warn(trouble: HearingTrouble): void {
    this.warned = true;
    this.onTrouble(trouble);
  }
}
