import { describe, expect, it } from 'vitest';
import { describeAudioCheck, judgeMic } from '../audio-check';
import { classifyError, describeModelCheck, isRecommended, needsHelp, recommend } from '../model-check';
import type { ModelOption, ModelProbe } from '../model-check';

describe('judgeMic', () => {
  it('tells hearing, quiet, silent, denied and failed apart from the levels', () => {
    expect(judgeMic({ ok: true, levels: [0.001, 0.15, 0.3, 0.05] }).verdict).toBe('hearing');
    expect(judgeMic({ ok: true, levels: [0.004, 0.008, 0.006] }).verdict).toBe('quiet');
    expect(judgeMic({ ok: true, levels: Array(20).fill(0) }).verdict).toBe('silent');
    expect(judgeMic({ ok: true, levels: [0.0005, 0.001] }).verdict).toBe('silent');
    expect(judgeMic({ ok: false, levels: [], denied: true }).verdict).toBe('denied');
    expect(judgeMic({ ok: false, levels: [], error: 'NotReadableError' }).verdict).toBe('failed');
    expect(judgeMic({ ok: true, levels: [] }).verdict).toBe('failed');
  });

  it('says what to do', () => {
    const base = { micChoice: 'MacBook Mic', speakerChoice: 'System default', tone: { ok: true } };
    const hearing = describeAudioCheck({ ...base, mic: { ok: true, levels: [0.2, 0.25], label: 'MacBook Mic' } });
    expect(hearing).toContain('I can hear you');
    expect(hearing).toContain('level went up to 50 of 100');
    expect(hearing).toContain('Ask the user whether they heard it');
    const silent = describeAudioCheck({ ...base, mic: { ok: true, levels: [0, 0, 0] } });
    expect(silent).toContain('Your mic is silent');
    expect(silent).toContain('Settings › Audio devices');
    // The chosen mic was gone and the default opened instead: say which one listened
    const fallback = describeAudioCheck({ ...base, mic: { ok: true, levels: [0.3], label: 'Default - Built-in' } });
    expect(fallback).toContain('(opened: Default - Built-in)');
    const noTone = describeAudioCheck({
      ...base,
      tone: { ok: false, error: 'no output' },
      mic: { ok: true, levels: [0.3] },
    });
    expect(noTone).toContain('The test tone could not play: no output');
    expect(describeAudioCheck({ ...base, systemVoice: true, mic: { ok: true, levels: [0.3] } })).toContain(
      'system voice',
    );
  });
});

describe('classifyError', () => {
  it('sorts errors by what the user can do', () => {
    expect(classifyError({ statusCode: 429, message: 'x' })).toBe('rate_limit');
    expect(classifyError(new Error('RESOURCE_EXHAUSTED: quota'))).toBe('rate_limit');
    expect(classifyError({ statusCode: 401, message: 'no' })).toBe('auth');
    expect(classifyError(new Error('Invalid API key provided'))).toBe('auth');
    expect(classifyError(new DOMException('The operation timed out.', 'TimeoutError'))).toBe('timeout');
    expect(classifyError(new TypeError('Failed to fetch'))).toBe('unreachable');
    expect(classifyError(new Error('something odd'))).toBe('other');
  });
});

const option = (over: Partial<ModelOption>): ModelOption => ({
  providerId: 'openai',
  providerName: 'OpenAI',
  model: 'gpt-x',
  local: false,
  health: 'ok',
  down: false,
  tags: ['chat'],
  ...over,
});
const probe = (over: Partial<ModelProbe>): ModelProbe => ({
  use: 'chat',
  providerId: 'anthropic',
  model: 'claude-x',
  ok: true,
  latencyMs: 900,
  errorKind: null,
  error: null,
  ...over,
});

describe('recommend', () => {
  const options = [
    option({}),
    option({ providerId: 'ollama', providerName: 'Ollama', model: 'qwen3.8', local: true }),
    option({ providerId: 'anthropic', model: 'claude-y' }),
    option({ providerId: 'xai', model: 'grok', down: true }),
    option({ providerId: 'gemini', providerName: 'Gemini', model: 'gemini-flash', tags: ['chat', 'audio'] }),
  ];

  it('recommends nothing when every model answers quickly', () => {
    expect(recommend([probe({}), probe({ use: 'speech', latencyMs: 1200 })], options)).toEqual([]);
    expect(needsHelp(probe({ use: 'voice', note: 'working: this conversation runs on it now.' }))).toBe(false);
  });

  it('a rate limit moves to another cloud provider first, never the failing one or one that is down', () => {
    const [item] = recommend([probe({ ok: false, errorKind: 'rate_limit' })], options);
    expect(item.switchTo).toMatchObject({ providerId: 'openai', model: 'gpt-x', local: false });
  });

  it('an unreachable, timing-out or slow model moves to a running local model first', () => {
    for (const failing of [
      probe({ ok: false, errorKind: 'unreachable' }),
      probe({ ok: false, errorKind: 'timeout' }),
      probe({ latencyMs: 12_000 }),
    ]) {
      expect(recommend([failing], options)[0].switchTo).toMatchObject({ providerId: 'ollama', local: true });
    }
  });

  it('a refused key says to replace it, and offers another provider meanwhile', () => {
    const [item] = recommend([probe({ ok: false, errorKind: 'auth' })], options);
    expect(item.reason).toContain('Replace the key');
    expect(item.switchTo?.providerId).toBe('openai');
  });

  it('speech-to-text only moves to a model that hears audio', () => {
    const [item] = recommend([probe({ use: 'speech', ok: false, errorKind: 'other' })], options);
    expect(item.switchTo).toMatchObject({ providerId: 'gemini', model: 'gemini-flash' });
  });

  it('nothing set, or no alternative, points to the place to fix it', () => {
    expect(
      recommend([probe({ ok: false, errorKind: 'not_set', providerId: null, model: null })], options)[0],
    ).toMatchObject({ switchTo: null, place: 'models' });
    expect(recommend([probe({ ok: false, errorKind: 'other' })], [])[0].switchTo).toBeNull();
    expect(recommend([probe({ use: 'voice', ok: false, errorKind: 'unreachable' })], options)[0]).toMatchObject({
      switchTo: null,
      place: 'voice-engines',
    });
  });

  it('describes the check, and only a recommended switch is allowed', () => {
    const probes = [probe({ ok: false, errorKind: 'rate_limit' }), probe({ use: 'speech', latencyMs: 700 })];
    const recommendations = recommend(probes, options);
    const text = describeModelCheck(probes, recommendations);
    expect(text).toContain('chat: claude-x (anthropic): failed (rate_limit)');
    expect(text).toContain('speech-to-text: claude-x (anthropic): answered in 0.7 s');
    expect(text).toContain('call switch_model with use "chat", provider "openai", model "gpt-x"');
    expect(isRecommended(recommendations, 'chat', 'openai', 'gpt-x')).not.toBeNull();
    expect(isRecommended(recommendations, 'chat', 'evil', 'model')).toBeNull();
    expect(describeModelCheck([probe({})], [])).toContain('no switch is needed');
  });
});
