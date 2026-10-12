import { describe, expect, it } from 'vitest';
import { setupCommand } from '../command';

describe('setupCommand', () => {
  it('is the plain setup when the chosen engines are installed or come with it', () => {
    expect(setupCommand({ stt: 'moonshine', moonshineSize: 'tiny' }, 'kitten', {})).toBe(
      'node scripts/voice-models-setup.mjs',
    );
    expect(setupCommand({ stt: 'gemini', moonshineSize: 'base' }, 'system', {})).toBe(
      'node scripts/voice-models-setup.mjs',
    );
  });

  it('adds a flag for each optional model chosen but missing', () => {
    expect(setupCommand({ stt: 'moonshine', moonshineSize: 'base' }, 'kokoro', {})).toBe(
      'node scripts/voice-models-setup.mjs --moonshine-base --kokoro',
    );
    expect(setupCommand({ stt: 'whisper', moonshineSize: 'tiny' }, 'kokoro', { kokoro: { bytes: 1 } })).toBe(
      'node scripts/voice-models-setup.mjs --whisper',
    );
  });

  it("sends Vosk to the wake word's setup, which installs its model", () => {
    expect(setupCommand({ stt: 'vosk', moonshineSize: 'tiny' }, 'kitten', {})).toBe(
      'node scripts/voice-models-setup.mjs && node scripts/wake-word-setup.mjs',
    );
    expect(setupCommand({ stt: 'vosk', moonshineSize: 'tiny' }, 'kitten', { vosk: { bytes: 1 } })).toBe(
      'node scripts/voice-models-setup.mjs',
    );
  });
});
