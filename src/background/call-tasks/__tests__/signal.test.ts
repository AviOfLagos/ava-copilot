import { describe, expect, it } from 'vitest';
import { CALL_DOM } from '../../meetings/captions';
import { decideSignal, labelledAsSelf } from '../signal';
import type { SignalInput } from '../signal';

const audio = (fields: Partial<SignalInput> = {}): SignalInput => ({
  source: 'audio',
  captionsOn: null,
  withMic: true,
  localStt: true,
  captionsLately: false,
  ...fields,
});

describe('decideSignal', () => {
  it('uses the page’s own-line mark when notes come from captions', () => {
    expect(decideSignal({ ...audio(), source: 'captions', captionsOn: true })).toEqual({
      signal: 'captions',
      wantMic: false,
    });
  });

  it('turns captions off for the call when Meet labelled the user’s line without the mark', () => {
    expect(decideSignal({ ...audio(), source: 'captions', captionsOn: true, selfMarkerMissing: true })).toEqual({
      signal: 'off',
      offReason: 'no_self_marker',
      wantMic: false,
    });
    // A marked line seen first proves the mark works: a guest named "You" later does not turn it off
    expect(
      decideSignal({ ...audio(), source: 'captions', captionsOn: true, selfMarkerMissing: true, selfLineSeen: true })
        .signal,
    ).toBe('captions');
  });

  it('turns captions off for the call when the mark was on another speaker’s line', () => {
    expect(
      decideSignal({ ...audio(), source: 'captions', captionsOn: true, selfLineSeen: true, selfMarkerOnOthers: true }),
    ).toMatchObject({ signal: 'off', offReason: 'no_self_marker' });
    expect(decideSignal(audio({ withMic: false, captionsLately: true, selfMarkerOnOthers: true })).signal).toBe('off');
  });

  it('uses a separate microphone stream when notes come from the tab’s audio', () => {
    expect(decideSignal(audio())).toEqual({ signal: 'mic', wantMic: true });
    // Even when the call shows captions: those are used only to refuse echoes
    expect(decideSignal(audio({ captionsLately: true })).signal).toBe('mic');
  });

  it('falls back to the call’s captions, then off, saying why', () => {
    expect(decideSignal(audio({ withMic: false, captionsLately: true })).signal).toBe('captions');
    expect(decideSignal(audio({ withMic: false }))).toMatchObject({ signal: 'off', offReason: 'mic_off' });
    expect(decideSignal(audio({ localStt: false }))).toMatchObject({ signal: 'off', offReason: 'no_local_recogniser' });
    expect(decideSignal(audio({ micFailed: 'denied' }))).toMatchObject({ signal: 'off', offReason: 'mic_denied' });
    expect(decideSignal({ ...audio(), source: 'captions', captionsOn: false })).toMatchObject({
      signal: 'off',
      offReason: 'no_captions_no_mic',
    });
  });
});

describe('labelledAsSelf', () => {
  it('knows Meet’s own label in the shipped languages, and nothing else', () => {
    for (const label of ['You', 'Você', '你', 'Ada (You)'])
      expect(labelledAsSelf(label, CALL_DOM.selfNames)).toBe(true);
    for (const label of ['Avi', 'Youssef', 'Ben']) expect(labelledAsSelf(label, CALL_DOM.selfNames)).toBe(false);
  });
});
