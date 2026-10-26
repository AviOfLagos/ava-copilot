import { describe, expect, it, vi } from 'vitest';
import type { RenderDeps } from '../../meet-voice/render';

vi.mock('../../voice/engines/offscreen', () => ({ toVoiceOffscreen: vi.fn() }));

const { voiceNoteOf } = await import('../voice-note');

const render = (spoken: string[]): RenderDeps => ({
  chosenEngine: async () => 'kokoro',
  geminiKey: async () => null,
  voiceFor: async () => ({ voice: 'af_heart', rate: 1 }),
  local: async (_engine, text) => {
    spoken.push(text);
    return 'UklGRg==';
  },
  gemini: async () => '',
});

describe('a WhatsApp voice note in her voice', () => {
  it('says the words in the chosen voice and makes the clip into Ogg/Opus', async () => {
    const spoken: string[] = [];
    const encode = vi.fn(async () => ({ ok: true, audio: 'T2dnUw==', seconds: 3, waveform: new Array(64).fill(10) }));
    const note = await voiceNoteOf('Two meetings tomorrow.', null, { render: render(spoken), encode });
    expect(spoken).toEqual(['Two meetings tomorrow.']);
    expect(encode).toHaveBeenCalledWith('UklGRg==');
    expect(note).toEqual({ audio: 'T2dnUw==', seconds: 3, waveform: expect.any(Array) });
  });

  it('fails plainly when the clip could not be encoded', async () => {
    const encode = async () => ({ ok: false, error: 'This browser cannot make Opus audio.' });
    await expect(voiceNoteOf('Hi.', null, { render: render([]), encode })).rejects.toThrow(/Opus/);
  });
});
