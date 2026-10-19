import type { MeetingRecord, ProviderConfig } from '@extension/storage';
import type { CallState } from './captions';
import type { ClipSegment } from './segments';

/**
 * The decisions that keep a meeting's notes actually coming in, kept apart from the Chrome calls so each
 * can be tested on its own: who writes the audio down, what to do when the page or the audio changes,
 * and whether the user has left the call.
 */

// Who turns a chunk of recorded audio into text
export type TranscriptionRoute<Stt> =
  // A model that takes audio: the speech-to-text setting, else Gemini Flash with the Gemini key
  | { kind: 'model'; provider: string; modelName: string }
  // The speech-to-text model installed on this computer (Moonshine, Whisper, Vosk), no key needed
  | { kind: 'local'; stt: Stt }
  // The browser agent's own model, which may not take audio at all: the last resort
  | { kind: 'agent' };

export const DEFAULT_TRANSCRIBER = 'gemini-3.8-flash';

/**
 * Picks who writes a meeting's audio down: the speech-to-text model chosen in settings, else Gemini
 * Flash when a Gemini key is set, else the speech-to-text model on this computer, else the agent's
 * model. Before the local model existed the last step came right after Gemini, so meetings with no
 * Gemini key were sent to a chat model that often cannot hear: every chunk failed, the meeting showed
 * "Recording" and its transcript stayed empty.
 */
export function transcriptionRoute<Stt>(
  chosen: { provider: string; modelName: string } | null | undefined,
  providers: Record<string, ProviderConfig>,
  localStt: Stt | null,
): TranscriptionRoute<Stt> {
  if (chosen?.provider && chosen.modelName && providers[chosen.provider]) {
    return { kind: 'model', provider: chosen.provider, modelName: chosen.modelName };
  }
  const gemini = Object.entries(providers).find(
    ([id, provider]) => (provider.type ?? id) === 'gemini' && Boolean(provider.apiKey),
  );
  if (gemini) return { kind: 'model', provider: gemini[0], modelName: DEFAULT_TRANSCRIBER };
  if (localStt) return { kind: 'local', stt: localStt };
  return { kind: 'agent' };
}

/** What the local recogniser heard in one chunk, as one line spanning the chunk (it gives no times or speakers). */
export function localClip(text: string, chunk: { index: number; tStart: number; tEnd: number }, overlap: number) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [] as ClipSegment[];
  const duration = Math.max(0, chunk.tEnd - chunk.tStart);
  // The words of the overlap belong to the chunk before; its middle stays inside this chunk
  const start = chunk.index > 0 ? Math.min(overlap, duration) : 0;
  return [{ start, end: duration, speaker: '', text: clean }] satisfies ClipSegment[];
}

/**
 * The tab's audio stopped while recording. The call goes on when the tab is still on it (Meet reloaded
 * or switched devices): notes continue from its captions rather than ending. Otherwise the meeting ends.
 */
export function afterAudioEnded(
  tab: { url?: string } | undefined,
  isCall: (url: string) => boolean,
): 'captions' | 'stop' {
  return tab?.url && isCall(tab.url) ? 'captions' : 'stop';
}

export interface KeepPlan {
  // Put the caption reader (or the call watcher) back: the page reloaded or the worker lost it
  reinject: boolean;
  // Press Meet's captions button again: captions are off and notes need them
  turnOnCaptions: boolean;
  // What to record on the meeting
  captionsOn: boolean | null;
}

/** What a periodic check of the call's page should do to keep notes coming in. */
export function keepPlan(
  meeting: Pick<MeetingRecord, 'source' | 'platform'>,
  state: Pick<CallState, 'watching' | 'captionsOn' | 'inCall'>,
): KeepPlan {
  const onMeet = meeting.platform === 'Google Meet';
  return {
    reinject: state.inCall && !state.watching,
    turnOnCaptions: meeting.source === 'captions' && onMeet && state.inCall && state.captionsOn === false,
    captionsOn: state.captionsOn,
  };
}

/**
 * Whether the user has left the call, from one check of the page and how many checks in a row before
 * found no Leave button. Meet's "you left" screen ends it at once; a Leave button missing for three
 * checks (it can vanish for a moment while the layout changes) does too.
 *
 * @returns whether it is over, and the count to keep for the next check
 */
export function leftCall(
  state: Pick<CallState, 'inCall' | 'left'> | null,
  misses: number,
): { left: boolean; misses: number } {
  // The page could not be read (it is loading): no evidence either way
  if (!state) return { left: false, misses };
  if (state.inCall) return { left: false, misses: 0 };
  if (state.left) return { left: true, misses: misses + 1 };
  return { left: misses + 1 >= 3, misses: misses + 1 };
}
