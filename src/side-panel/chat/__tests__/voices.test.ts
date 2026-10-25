import { describe, expect, it } from 'vitest';
import { kokoroLabel, voicesFor } from '../TtsSettingsSection';

describe('voice lists per engine', () => {
  it('reads Kokoro ids as names with accent and voice', () => {
    expect(kokoroLabel('af_heart')).toBe('Heart · US ♀');
    expect(kokoroLabel('bm_george')).toBe('George · UK ♂');
  });

  it('offers each engine its own voices', () => {
    expect(voicesFor('kitten', []).map(voice => voice.value)).toContain('Bella');
    expect(voicesFor('kokoro', []).map(voice => voice.value)).toContain('af_heart');
    expect(voicesFor('gemini', []).some(voice => voice.value === 'Kore' && voice.label.includes('Firm'))).toBe(true);
    expect(voicesFor('system', ['Samantha'])).toEqual([{ value: 'Samantha', label: 'Samantha' }]);
  });
});
