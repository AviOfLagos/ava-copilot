import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireStt, releaseStt, unloadStt } from '../pool';
import type { SttEngine } from '../engines';

const fake = (): SttEngine => ({
  load: vi.fn(async () => ({ device: 'wasm' as const, ms: 1 })),
  transcribe: vi.fn(async () => ''),
  dispose: vi.fn(),
});

describe('the speech engine pool', () => {
  afterEach(() => {
    releaseStt();
    releaseStt();
    unloadStt();
  });

  it('lends the engine in use instead of pulling it away, and replaces it once it is free', async () => {
    const listening = fake();
    const next = fake();
    const create = vi.fn().mockReturnValueOnce(listening).mockReturnValueOnce(next);
    await acquireStt({ engine: 'moonshine', model: 'moonshine-tiny' }, create);
    expect(await acquireStt({ engine: 'whisper', model: 'whisper-base' }, create)).toBe(listening);
    expect(listening.dispose).not.toHaveBeenCalled();
    releaseStt();
    releaseStt();
    expect(await acquireStt({ engine: 'whisper', model: 'whisper-base' }, create)).toBe(next);
    expect(listening.dispose).toHaveBeenCalled();
  });
});
