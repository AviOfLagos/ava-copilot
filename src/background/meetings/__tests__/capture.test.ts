import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@extension/storage';
import { afterAudioEnded, DEFAULT_TRANSCRIBER, keepPlan, leftCall, localClip, transcriptionRoute } from '../capture';
import { isCallUrl } from '../call-url';
import { placeSegments } from '../segments';

const provider = (fields: { type?: string; apiKey?: string }): ProviderConfig =>
  ({ name: 'x', apiKey: '', createdAt: 0, ...fields }) as unknown as ProviderConfig;
const MOONSHINE = { engine: 'moonshine', model: 'moonshine-tiny', webgpu: false };

describe('transcriptionRoute', () => {
  it('uses the speech-to-text model chosen in settings first', () => {
    const providers = {
      openai: provider({ type: 'openai', apiKey: 'k' }),
      gemini: provider({ type: 'gemini', apiKey: 'g' }),
    };
    expect(transcriptionRoute({ provider: 'openai', modelName: 'gpt-4o-transcribe' }, providers, MOONSHINE)).toEqual({
      kind: 'model',
      provider: 'openai',
      modelName: 'gpt-4o-transcribe',
    });
  });

  it('else Gemini Flash, when Gemini has a key', () => {
    const providers = { gemini: provider({ type: 'gemini', apiKey: 'g' }) };
    expect(transcriptionRoute(null, providers, MOONSHINE)).toEqual({
      kind: 'model',
      provider: 'gemini',
      modelName: DEFAULT_TRANSCRIBER,
    });
  });

  it('with no Gemini key, the model on this computer writes the audio down (it used to go to a chat model)', () => {
    const providers = { openai: provider({ type: 'openai', apiKey: 'k' }), gemini: provider({ type: 'gemini' }) };
    expect(transcriptionRoute(null, providers, MOONSHINE)).toEqual({ kind: 'local', stt: MOONSHINE });
  });

  it("falls back to the agent's model only when nothing else can hear", () => {
    expect(transcriptionRoute(null, { openai: provider({ type: 'openai', apiKey: 'k' }) }, null)).toEqual({
      kind: 'agent',
    });
    // A chosen model whose provider was removed does not count
    expect(transcriptionRoute({ provider: 'gone', modelName: 'm' }, {}, null)).toEqual({ kind: 'agent' });
  });
});

describe('localClip', () => {
  const chunk = { index: 1, tStart: 28, tEnd: 58 };

  it('makes one line for the chunk, starting after the overlap the chunk before covers', () => {
    const clip = localClip('  ship it   on Friday ', chunk, 2);
    expect(clip).toEqual([{ start: 2, end: 30, speaker: '', text: 'ship it on Friday' }]);
    // It survives being placed on the timeline (its middle is inside this chunk)
    expect(placeSegments(clip, chunk, 2, false)).toHaveLength(1);
  });

  it('starts the first chunk at zero, and makes nothing of silence', () => {
    expect(localClip('hello', { index: 0, tStart: 0, tEnd: 8 }, 2)[0].start).toBe(0);
    expect(localClip('   ', chunk, 2)).toEqual([]);
  });
});

describe('afterAudioEnded', () => {
  it('goes on from the captions while the tab is still on the call', () => {
    expect(afterAudioEnded({ url: 'https://meet.google.com/abc-defg-hij' }, isCallUrl)).toBe('captions');
  });

  it('ends the meeting when the tab closed or left the call', () => {
    expect(afterAudioEnded(undefined, isCallUrl)).toBe('stop');
    expect(afterAudioEnded({ url: 'https://meet.google.com/' }, isCallUrl)).toBe('stop');
    expect(afterAudioEnded({ url: 'https://example.com/' }, isCallUrl)).toBe('stop');
  });
});

describe('keepPlan', () => {
  const meet = { source: 'captions' as const, platform: 'Google Meet' };

  it('turns Meet captions back on when notes need them', () => {
    expect(keepPlan(meet, { inCall: true, watching: true, captionsOn: false })).toEqual({
      reinject: false,
      turnOnCaptions: true,
      captionsOn: false,
    });
  });

  it('never presses the captions button when the audio is recorded, or off Meet', () => {
    expect(
      keepPlan({ ...meet, source: 'audio' }, { inCall: true, watching: true, captionsOn: false }).turnOnCaptions,
    ).toBe(false);
    expect(
      keepPlan({ ...meet, platform: 'Zoom' }, { inCall: true, watching: true, captionsOn: false }).turnOnCaptions,
    ).toBe(false);
  });

  it('puts the reader back after the page lost it, while the user is in the call', () => {
    expect(keepPlan(meet, { inCall: true, watching: false, captionsOn: true }).reinject).toBe(true);
    expect(keepPlan(meet, { inCall: false, watching: false, captionsOn: null }).reinject).toBe(false);
  });
});

describe('leftCall', () => {
  it("ends at once on Meet's left screen", () => {
    expect(leftCall({ inCall: false, left: true }, 0)).toEqual({ left: true, misses: 1 });
  });

  it('ends after three checks in a row without a Leave button, and resets when it shows again', () => {
    let misses = 0;
    for (const expected of [false, false, true]) {
      const verdict = leftCall({ inCall: false, left: false }, misses);
      expect(verdict.left).toBe(expected);
      misses = verdict.misses;
    }
    expect(leftCall({ inCall: true, left: false }, 2)).toEqual({ left: false, misses: 0 });
  });

  it('takes an unreadable page as no evidence', () => {
    expect(leftCall(null, 2)).toEqual({ left: false, misses: 2 });
  });
});
