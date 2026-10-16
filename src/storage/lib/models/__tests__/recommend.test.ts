import { describe, expect, it } from 'vitest';
import { memoryEstimate, platformOf, recommendLocalModels, tierFor } from '../recommend';
import type { SystemSpec } from '../recommend';

const spec = (extra: Partial<SystemSpec> = {}): SystemSpec => ({
  reportedMemoryGb: 8,
  userMemoryGb: null,
  cores: 10,
  platform: 'mac',
  gpu: { vendor: 'apple', architecture: 'metal-3' },
  ...extra,
});

describe('memory', () => {
  it('trusts what the user says, and treats the browser’s 8 GB as a floor', () => {
    expect(memoryEstimate(spec({ userMemoryGb: 32 }))).toEqual({ gb: 32, certain: true });
    expect(memoryEstimate(spec())).toEqual({ gb: 8, certain: false });
    expect(memoryEstimate(spec({ reportedMemoryGb: 4 }))).toEqual({ gb: 4, certain: true });
    expect(memoryEstimate(spec({ reportedMemoryGb: null }))).toEqual({ gb: 8, certain: false });
  });
});

describe('local recommendations', () => {
  const names = (value: SystemSpec, installed: string[] = []) =>
    recommendLocalModels(value, installed).map(rec => rec.name);

  it('fit small machines with a small chat model and an embedding model', () => {
    expect(names(spec({ reportedMemoryGb: 4 }))).toEqual(['qwen3:1.7b', 'nomic-embed-text']);
  });

  it('add vision at 8 GB and a separate light model from 16 GB', () => {
    expect(names(spec())).toEqual(['qwen3:4b', 'gemma3:4b', 'nomic-embed-text']);
    expect(names(spec({ userMemoryGb: 16 }))).toEqual(['qwen3:8b', 'qwen3:4b', 'gemma3:4b', 'nomic-embed-text']);
    expect(names(spec({ userMemoryGb: 32 }))[0]).toBe('qwen3:14b');
    expect(names(spec({ userMemoryGb: 64 }))[0]).toBe('qwen3:30b');
  });

  it('always offer two to four, each with its install command and size', () => {
    for (const gb of [2, 8, 16, 32, 64, 128]) {
      const recs = recommendLocalModels(spec({ userMemoryGb: gb }), []);
      expect(recs.length).toBeGreaterThanOrEqual(2);
      expect(recs.length).toBeLessThanOrEqual(4);
      for (const rec of recs) {
        expect(rec.command).toBe(`ollama pull ${rec.name}`);
        // A model takes at most about half the memory
        expect(rec.sizeGb).toBeLessThanOrEqual(Math.max(gb, 4) / 2);
      }
    }
  });

  it('step down on a machine with few cores', () => {
    expect(tierFor(spec({ userMemoryGb: 16, cores: 2 }))).toBe(tierFor(spec({ userMemoryGb: 8 })));
  });

  it('mark installed models, ignoring Ollama’s :latest tag', () => {
    const recs = recommendLocalModels(spec(), ['nomic-embed-text:latest', 'qwen3:4b']);
    expect(recs.filter(rec => rec.installed).map(rec => rec.name)).toEqual(['qwen3:4b', 'nomic-embed-text']);
  });

  it('read the platform', () => {
    expect(platformOf('macOS')).toBe('mac');
    expect(platformOf('MacIntel')).toBe('mac');
    expect(platformOf('Windows')).toBe('windows');
    expect(platformOf('')).toBeNull();
  });
});
