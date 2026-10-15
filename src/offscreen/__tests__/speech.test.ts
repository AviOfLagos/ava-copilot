import { describe, expect, it } from 'vitest';
import { screenFrame, voiceSetup } from '../voice';

const base = { endpoint: 'wss://x', apiKey: 'k', model: 'gemini-3.8-live', instructions: 'Be Ava.', tools: [] };

describe('voiceSetup', () => {
  it('fixes the voice (and language, when given) in the generation config', () => {
    const setup = voiceSetup(
      {
        ...base,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } }, languageCode: 'en-US' },
      },
      null,
    );
    expect(setup.setup.generationConfig).toEqual({
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } }, languageCode: 'en-US' },
    });
  });

  it('leaves the speech config out when there is none', () => {
    expect(voiceSetup(base, null).setup.generationConfig).toEqual({ responseModalities: ['AUDIO'] });
  });
});

describe('screenFrame', () => {
  it('sends a screenshot as a realtime video frame, not a turn', () => {
    expect(screenFrame({ mediaType: 'image/jpeg', data: 'AAAA' })).toEqual({
      realtimeInput: { video: { mimeType: 'image/jpeg', data: 'AAAA' } },
    });
  });
});
