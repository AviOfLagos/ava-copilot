/**
 * Which signal says whose speech counts on a call (docs/pm-desk.md, Part 6). Plain code with tests.
 *
 * - Notes from captions: the page's own-line mark on each caption block ('captions').
 * - Notes from the tab's audio: the recorder mixes the microphone into the tab's sound, so nothing there is only
 *   Avi's. Commands use a separate echo-cancelled microphone stream and the recogniser on this computer ('mic'),
 *   when notes already use his microphone and a local recogniser is installed. Without it, the captions the call
 *   shows, if any, with their own-line mark.
 * - Neither: 'off', with the reason the panel shows.
 *
 * A caption line is the user's own only when the page marks it AND labels it as the user's ("You"): the label alone
 * a guest can copy, the mark alone has not been seen on a live call. Either one without the other turns the
 * captions signal off for the call: a "You" line with no mark (before any marked one) means the mark is missing; a
 * marked line with another name means the mark is not about whose line it is.
 */
import type { CallCommandOffReason, CallCommandSignal, MeetingRecord } from '@extension/storage';

export interface SignalInput {
  source: MeetingRecord['source'];
  captionsOn: boolean | null | undefined;
  withMic: boolean;
  // A local speech-to-text model is installed and chosen
  localStt: boolean;
  micFailed?: 'denied' | 'failed';
  // Caption lines came from the call lately (in audio mode the page still reads them for speaker names)
  captionsLately: boolean;
  selfMarkerMissing?: boolean;
  selfLineSeen?: boolean;
  // The page's mark was on a line not labelled as the user's: it does not mean "mine" on this call
  selfMarkerOnOthers?: boolean;
}

export interface SignalDecision {
  signal: CallCommandSignal;
  offReason?: CallCommandOffReason;
  // Whether the microphone stream for commands should be listening
  wantMic: boolean;
}

export function decideSignal(input: SignalInput): SignalDecision {
  const markerOk = !input.selfMarkerOnOthers && (!input.selfMarkerMissing || input.selfLineSeen === true);
  if (input.source === 'audio') {
    if (input.withMic && input.localStt && !input.micFailed) return { signal: 'mic', wantMic: true };
    if (input.captionsLately && markerOk) return { signal: 'captions', wantMic: false };
    const offReason: CallCommandOffReason = !markerOk
      ? 'no_self_marker'
      : input.micFailed === 'denied'
        ? 'mic_denied'
        : !input.withMic
          ? 'mic_off'
          : !input.localStt
            ? 'no_local_recogniser'
            : 'no_captions_no_mic';
    return { signal: 'off', offReason, wantMic: false };
  }
  if (input.captionsOn === false) return { signal: 'off', offReason: 'no_captions_no_mic', wantMic: false };
  if (!markerOk) return { signal: 'off', offReason: 'no_self_marker', wantMic: false };
  return { signal: 'captions', wantMic: false };
}

/** Whether a caption speaker's label is the page calling the line the user's own ("You", "Você", "(You)"). */
export function labelledAsSelf(speaker: string, selfNames: string): boolean {
  return new RegExp(selfNames, 'i').test(speaker.trim());
}
