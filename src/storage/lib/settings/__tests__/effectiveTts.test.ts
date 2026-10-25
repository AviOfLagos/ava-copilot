import { describe, expect, it } from 'vitest';
import { effectiveTtsEngine } from '../ttsSettings';

const ready = { webgpu: false } as never;

describe('effectiveTtsEngine', () => {
  it('keeps the user’s own pick, even the system voices', () => {
    expect(effectiveTtsEngine({ engine: 'system', engineChosen: true }, { kitten: ready })).toBe('system');
    expect(effectiveTtsEngine({ engine: 'gemini', engineChosen: true }, { kitten: ready })).toBe('gemini');
  });

  it('until a pick, speaks with a voice on this computer when one is installed', () => {
    expect(effectiveTtsEngine({ engine: 'system', engineChosen: false }, { kitten: ready, kokoro: ready })).toBe(
      'kitten',
    );
    expect(effectiveTtsEngine({ engine: 'system', engineChosen: false }, { kokoro: ready })).toBe('kokoro');
  });

  it('falls back to the stored engine when nothing local is installed, or it cannot tell', () => {
    expect(effectiveTtsEngine({ engine: 'system', engineChosen: false }, {})).toBe('system');
    expect(effectiveTtsEngine({ engine: 'system', engineChosen: false }, null)).toBe('system');
  });
});
