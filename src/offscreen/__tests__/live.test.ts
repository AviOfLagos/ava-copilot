import { describe, expect, it } from 'vitest';
import { liveSetup, pcm16Base64 } from '../live';

describe('pcm16Base64', () => {
  it('writes 16-bit little-endian samples', () => {
    const bytes = Uint8Array.from(atob(pcm16Base64(Float32Array.from([0, 1, -1, 2]))), c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect([view.getInt16(0, true), view.getInt16(2, true), view.getInt16(4, true), view.getInt16(6, true)]).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });
});

describe('liveSetup', () => {
  it('asks for the input transcript and caps the reply so the model stays silent', () => {
    const { setup } = liveSetup('gemini-3.8-live', null);
    expect(setup.model).toBe('models/gemini-3.8-live');
    expect(setup.generationConfig).toEqual({ responseModalities: ['AUDIO'], maxOutputTokens: 1 });
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.sessionResumption).toEqual({});
  });

  it('resumes a session with its handle', () => {
    expect(liveSetup('gemini-3.8-live', 'abc').setup.sessionResumption).toEqual({ handle: 'abc' });
  });
});

describe('voice audio', () => {
  it('reads the model 16-bit PCM back into samples', async () => {
    const { pcm16ToFloat } = await import('../voice');
    const samples = pcm16ToFloat(pcm16Base64(Float32Array.from([0, 0.5, -0.5])));
    expect(Array.from(samples).map(s => Math.round(s * 100) / 100)).toEqual([0, 0.5, -0.5]);
  });
});
