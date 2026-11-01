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

  it('runs another recogniser beside the one in use, and ends it when released', async () => {
    const listening = fake();
    const whisper = fake();
    const create = vi.fn().mockReturnValueOnce(listening).mockReturnValueOnce(whisper);
    await acquireStt({ engine: 'moonshine', model: 'moonshine-tiny' }, create);
    const own = await acquireStt({ engine: 'whisper', model: 'whisper-base' }, create);
    expect(own).toBe(whisper);
    expect(listening.dispose).not.toHaveBeenCalled();
    releaseStt(own);
    expect(whisper.dispose).toHaveBeenCalled();
    expect(listening.dispose).not.toHaveBeenCalled();
  });

  it('replaces an engine nobody is using', async () => {
    const old = fake();
    const next = fake();
    const create = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next);
    releaseStt(await acquireStt({ engine: 'moonshine', model: 'moonshine-tiny' }, create));
    expect(await acquireStt({ engine: 'whisper', model: 'whisper-base' }, create)).toBe(next);
    expect(old.dispose).toHaveBeenCalled();
  });
});
