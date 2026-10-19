import { describe, expect, it } from 'vitest';
import { BUILTIN_PERSONALITIES, DEFAULT_PERSONALITY_ID } from '../builtins';
import {
  allPersonalities,
  checkPersonality,
  cleanVoices,
  EMPTY_PERSONALITIES,
  layeredVoices,
  migrateVoices,
  normalizePersonalities,
  personalityVoiceFor,
  pickSystemVoice,
} from '../personalities';
import { liveSpeechConfig } from '../../identity/voice';
import { VOICE_SLOTS } from '../types';
import type { Personality } from '../types';

const old = (voice: string) =>
  ({ id: 'custom-a', name: 'A', description: '', icon: '💬', instructions: 'Be brief.', voice, rate: 0 }) as Omit<
    Personality,
    'voices'
  > as Personality;

describe('the old single voice', () => {
  it('moves into the slot of the engine it names', () => {
    expect(migrateVoices({ voice: 'af_bella' })).toEqual({ kokoro: 'af_bella' });
    expect(migrateVoices({ voice: 'Leo' })).toEqual({ kitten: 'Leo' });
    expect(migrateVoices({ voice: 'Puck' })).toEqual({ live: 'Puck' });
    expect(migrateVoices({ voice: 'Samantha' })).toEqual({ system: 'Samantha' });
    expect(migrateVoices({ voice: '' })).toEqual({});
    // Voices per engine win over anything older
    expect(migrateVoices({ voice: 'Leo', voices: { kitten: 'Hugo' } })).toEqual({ kitten: 'Hugo' });
  });

  it('is migrated when stored personalities are read, and the old field is dropped', () => {
    const state = normalizePersonalities({ custom: [old('am_michael'), { ...old('Samantha'), id: 'custom-b' }] });
    expect(state.custom.map(item => item.voices)).toEqual([{ kokoro: 'am_michael' }, { system: 'Samantha' }]);
    expect(state.custom.every(item => !('voice' in item))).toBe(true);
  });

  it('is migrated when a personality is saved', () => {
    const check = checkPersonality(old('bf_emma'));
    expect(check.ok && check.personality.voices).toEqual({ kokoro: 'bf_emma' });
  });
});

describe('voices per engine', () => {
  it('only keeps a voice in its own engine', () => {
    expect(cleanVoices({ live: 'Leo', kitten: 'Leo', kokoro: 'Puck', system: ' Daniel ' })).toEqual({
      kitten: 'Leo',
      system: 'Daniel',
    });
  });

  it('gives each engine its own voice, Gemini read-aloud the Live one', () => {
    const voices = { live: 'Charon', kitten: 'Hugo', kokoro: 'bm_george', system: 'Daniel' };
    expect(personalityVoiceFor('live', { voices })).toBe('Charon');
    expect(personalityVoiceFor('gemini', { voices })).toBe('Charon');
    expect(personalityVoiceFor('kitten', { voices })).toBe('Hugo');
    expect(personalityVoiceFor('kokoro', { voices })).toBe('bm_george');
    expect(personalityVoiceFor('system', { voices })).toBe('Daniel');
    expect(personalityVoiceFor('kitten', { voices: {} })).toBeUndefined();
    expect(personalityVoiceFor('other', { voices })).toBeUndefined();
  });

  it('layers an agent voice over its personality', () => {
    expect(
      layeredVoices({ kitten: 'Jasper' }, { kitten: 'Leo', live: 'Puck' }, { live: 'Kore', kokoro: 'af_sarah' }),
    ).toEqual({
      kitten: 'Jasper',
      live: 'Puck',
      kokoro: 'af_sarah',
    });
  });

  it('picks the first system voice this computer has, matched by name', () => {
    const installed = ['Samantha', 'Daniel (English (United Kingdom))', 'Google UK English Male'];
    expect(pickSystemVoice('Alex|Daniel|Google UK English Male', installed)).toBe('Daniel (English (United Kingdom))');
    expect(pickSystemVoice('Google UK English Male', installed)).toBe('Google UK English Male');
    expect(pickSystemVoice('Alex|Fred', installed)).toBeUndefined();
    expect(pickSystemVoice(undefined, installed)).toBeUndefined();
  });
});

describe('the built-in personalities', () => {
  const others = BUILTIN_PERSONALITIES.filter(item => item.id !== DEFAULT_PERSONALITY_ID);

  it('sound different from each other on every engine', () => {
    for (const slot of VOICE_SLOTS) {
      const voices = others.map(item => item.voices[slot]);
      expect(voices.every(Boolean), slot).toBe(true);
      // System entries list fallbacks, so compare their first choice
      expect(new Set(voices.map(voice => voice!.split('|')[0])).size, slot).toBe(others.length);
    }
  });

  it("never take Ava's own Settings voices, and the default keeps them", () => {
    expect(BUILTIN_PERSONALITIES.find(item => item.id === DEFAULT_PERSONALITY_ID)!.voices).toEqual({});
    for (const item of others) {
      expect(item.voices.live).not.toBe('Aoede');
      expect(item.voices.kitten).not.toBe('Bella');
      expect(item.voices.kokoro).not.toBe('af_heart');
      expect(cleanVoices(item.voices)).toEqual(item.voices);
    }
  });

  it('take the voices the user gave them', () => {
    const state = normalizePersonalities({
      ...EMPTY_PERSONALITIES,
      voiceOverrides: {
        engineer: { voices: { live: 'Fenrir', kitten: 'nope' }, rate: 1.25 },
        ghost: { voices: {}, rate: 1 },
      },
    });
    expect(Object.keys(state.voiceOverrides!)).toEqual(['engineer']);
    const engineer = allPersonalities(state).find(item => item.id === 'engineer')!;
    expect(engineer.voices).toEqual({ live: 'Fenrir' });
    expect(engineer.rate).toBe(1.25);
    expect(engineer.builtIn).toBe(true);
  });
});

describe('the Live setup voice', () => {
  it("is the personality's Live voice, else Ava's, and the language stays the Settings one", () => {
    const settings = { liveVoice: 'Aoede', language: 'pt-BR' };
    expect(liveSpeechConfig('gemini-live-2.5-flash', settings, 'puck')).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
      languageCode: 'pt-BR',
    });
    expect(liveSpeechConfig('gemini-3.8-live', settings, undefined).voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      'Aoede',
    );
    expect(liveSpeechConfig('gemini-3.8-live', settings, 'Bella').voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      'Aoede',
    );
  });
});
