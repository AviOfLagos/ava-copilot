import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_ENGINE_SETTINGS } from '../voiceEngineSettings';
import { activePreset, presetById, presetChanges, presetStatus, recommendPreset, VOICE_PRESETS } from '../voicePresets';

const reading = (speed: number) => ({ speed, at: 1, source: 'benchmark' as const });
const both = { 'moonshine-tiny': { bytes: 1 }, kitten: { bytes: 1 } };
const none = { tts: {}, stt: {}, checkedAt: null };

describe('presetStatus', () => {
  it('lists what to download first, with its size', () => {
    const state = presetStatus(presetById('light'), { installed: {}, hasGeminiKey: false, health: none });
    expect(state).toMatchObject({ available: false, missing: ['moonshine-tiny', 'kitten'], missingMb: 60 });
  });

  it('is available once its files are here', () => {
    const state = presetStatus(presetById('light'), { installed: both, hasGeminiKey: false, health: none });
    expect(state).toMatchObject({ available: true, missing: [], tooSlow: false, speaking: 'unknown' });
  });

  it('needs a Gemini key for the cloud, and nothing to download', () => {
    const cloud = presetById('cloud');
    expect(presetStatus(cloud, { installed: {}, hasGeminiKey: false, health: none })).toMatchObject({
      available: false,
      needsKey: true,
      missing: [],
    });
    expect(presetStatus(cloud, { installed: {}, hasGeminiKey: true, health: none }).available).toBe(true);
  });

  it('says when its voice was measured slower than speech here', () => {
    const state = presetStatus(presetById('light'), {
      installed: both,
      hasGeminiKey: false,
      health: { tts: { kitten: reading(0.73) }, stt: {} },
    });
    expect(state).toMatchObject({ speaking: 'too-slow', tooSlow: true, available: true });
  });
});

describe('recommendPreset', () => {
  it("starts safe with the computer's own voice when nothing was measured", () => {
    expect(recommendPreset({ installed: both, hasGeminiKey: true, health: none })).toEqual({
      id: 'instant',
      reason: 'unchecked',
    });
  });

  it('never recommends a voice that was measured too slow, and says it was checked', () => {
    const health = { tts: { kitten: reading(0.73) }, stt: {}, checkedAt: 5 };
    expect(recommendPreset({ installed: both, hasGeminiKey: false, health })).toEqual({
      id: 'instant',
      reason: 'measured',
    });
  });

  it('recommends the most natural voice that keeps up', () => {
    const kokoro = { ...both, kokoro: { bytes: 1 } };
    expect(
      recommendPreset({
        installed: both,
        hasGeminiKey: false,
        health: { tts: { kitten: reading(2.5) }, stt: {}, checkedAt: 5 },
      }).id,
    ).toBe('light');
    expect(
      recommendPreset({
        installed: kokoro,
        hasGeminiKey: false,
        health: { tts: { kitten: reading(2.5), kokoro: reading(1.4) }, stt: {}, checkedAt: 5 },
      }).id,
    ).toBe('natural');
    // A voice measured earlier whose files were since removed is not recommended
    expect(
      recommendPreset({
        installed: {},
        hasGeminiKey: false,
        health: { tts: { kitten: reading(2.5) }, stt: {}, checkedAt: 5 },
      }).id,
    ).toBe('instant');
  });

  it('suggests the cloud only when listening on the device was measured too slow, and a key is there', () => {
    const health = { tts: {}, stt: { moonshine: reading(0.6) }, checkedAt: 5 };
    expect(recommendPreset({ installed: both, hasGeminiKey: true, health })).toEqual({
      id: 'cloud',
      reason: 'hearing-slow',
    });
    expect(recommendPreset({ installed: both, hasGeminiKey: false, health }).id).toBe('instant');
  });
});

describe('applying a preset', () => {
  it('writes the settings it describes, and is then the one in use', () => {
    for (const preset of VOICE_PRESETS) {
      const { engine, tts } = presetChanges(preset.id);
      const settings = { ...DEFAULT_VOICE_ENGINE_SETTINGS, ...engine };
      expect(activePreset(settings, tts)).toBe(preset.id);
    }
  });

  it('is none of them after a hand-made change', () => {
    const { engine } = presetChanges('light');
    expect(activePreset({ ...DEFAULT_VOICE_ENGINE_SETTINGS, ...engine, moonshineSize: 'base' }, 'kitten')).toBeNull();
  });

  it('keeps the audio on the computer for every preset but the cloud', () => {
    expect(VOICE_PRESETS.filter(preset => preset.leavesDevice).map(preset => preset.id)).toEqual(['cloud']);
    expect(presetById('cloud').engine.mode).toBe('live');
  });
});
