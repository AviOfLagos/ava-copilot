import { describe, expect, it } from 'vitest';
import { diagnoseVoice, voiceReport } from '../voiceDiagnose';
import type { VoiceTraceEntry } from '../voiceHealth';

const NOW = 1_800_000_000_000;
const entry = (changes: Partial<VoiceTraceEntry> = {}): VoiceTraceEntry => ({
  at: NOW - 1000,
  kind: 'tts',
  engine: 'kitten',
  ok: true,
  chars: 180,
  audioSeconds: 12,
  workMs: 16_000,
  speed: 0.75,
  firstAudioMs: 6000,
  ...changes,
});
const health = { tts: {}, stt: {}, checkedAt: NOW - 5000 };
const ids = (entries: VoiceTraceEntry[], h = health) => diagnoseVoice({ entries, health: h, now: NOW }).map(f => f.id);

describe('diagnoseVoice', () => {
  it('finds nothing when the voice keeps up', () => {
    const good = [entry({ speed: 2.5, firstAudioMs: 900 }), entry({ speed: 2.4, firstAudioMs: 800 })];
    expect(ids(good)).toEqual([]);
  });

  it('finds speech made slower than it plays, as a problem with a fix', () => {
    const findings = diagnoseVoice({ entries: [entry(), entry({ speed: 0.71 })], health, now: NOW });
    expect(findings[0]).toMatchObject({
      id: 'tts-slower-than-speech',
      severity: 'problem',
      params: ['kitten', '0.73'],
      fix: { kind: 'preset', preset: 'instant' },
    });
  });

  it('calls a voice that only just misses a note, not a problem', () => {
    const findings = diagnoseVoice({ entries: [entry({ speed: 1.05 }), entry({ speed: 1.1 })], health, now: NOW });
    expect(findings[0]).toMatchObject({ id: 'tts-slower-than-speech', severity: 'note' });
  });

  it('finds the pauses a listener heard', () => {
    const gaps = { count: 3, totalMs: 3600, longestMs: 2400 };
    const found = diagnoseVoice({
      entries: [entry({ speed: 2, gaps }), entry({ speed: 2, gaps })],
      health,
      now: NOW,
    }).find(finding => finding.id === 'tts-pauses');
    expect(found).toMatchObject({ severity: 'problem', params: ['2', '2.4'] });
  });

  it('uses the benchmark when there are too few answers', () => {
    const measured = { ...health, tts: { kitten: { speed: 0.7, at: NOW, source: 'benchmark' as const } } };
    expect(ids([], measured)).toEqual(['tts-slower-than-speech']);
  });

  it('finds a voice that keeps failing, and a recogniser slower than speech', () => {
    const failing = [entry({ ok: false }), entry({ ok: false })];
    expect(ids(failing.map(e => ({ ...e, speed: undefined })))).toContain('tts-failing');
    const stt = { ...health, stt: { moonshine: { speed: 0.8, at: NOW, source: 'benchmark' as const } } };
    expect(diagnoseVoice({ entries: [], health: stt, now: NOW })[0]).toMatchObject({
      id: 'stt-slow',
      severity: 'problem',
    });
  });

  it('notes fallbacks, and an unchecked computer using a local voice', () => {
    const fell = entry({ kind: 'fallback', speed: 0.7 });
    expect(ids([fell])).toContain('fallback-used');
    expect(ids([entry({ speed: 2.5, firstAudioMs: 500 })], { ...health, checkedAt: null as never })).toEqual([
      'unchecked',
    ]);
  });

  it('puts problems before notes and forgets what is over a week old', () => {
    const found = ids([entry({ kind: 'fallback' }), entry({ speed: 0.7 }), entry({ speed: 0.7 })]);
    expect(found[0]).toBe('tts-slower-than-speech');
    const old = entry({ at: NOW - 8 * 24 * 3600 * 1000 });
    expect(ids([old, old, old])).toEqual([]);
  });
});

describe('voiceReport', () => {
  it("holds sizes and times, with this computer's facts, and no words", () => {
    const gaps = { count: 2, totalMs: 3000, longestMs: 2000 };
    const entries = [entry({ gaps }), entry({ gaps })];
    const findings = diagnoseVoice({ entries, health, now: NOW });
    const report = voiceReport({
      entries,
      health: {
        ...health,
        tts: { kitten: { speed: 0.73, at: NOW, source: 'benchmark' } },
        machine: { cores: 8, memoryGb: 8, webgpu: true, threads: false },
        lastFallback: null,
      },
      findings,
      version: '0.2.4',
      userAgent: 'Chrome/150',
    });
    expect(report).toContain('Ava 0.2.4, Chrome/150');
    expect(report).toContain('8 cores');
    expect(report).toContain('Speaking kitten: 0.73× (benchmark)');
    expect(report).toContain('2 / 3000 / 2000');
    expect(report).toContain('tts-slower-than-speech');
  });
});
