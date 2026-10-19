import { describe, expect, it, vi } from 'vitest';
import { createRequirementFlow } from '../flow';
import type { Requirement } from '../flow';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function requirement(overrides: Partial<Requirement> = {}): Requirement & { ready: boolean } {
  const item: Requirement & { ready: boolean } = {
    id: 'kitten',
    label: 'KittenTTS',
    sizeBytes: 28e6,
    ready: false,
    isReady: async (): Promise<boolean> => item.ready,
    install: async (onProgress: (p: { received: number; total: number }) => void) => {
      onProgress({ received: 14, total: 28 });
      item.ready = true;
    },
    ...overrides,
  };
  return item;
}

describe('requirement flow', () => {
  it('saves at once when the requirement is ready', async () => {
    const flow = createRequirementFlow();
    const save = vi.fn();
    const ready = requirement();
    ready.ready = true;
    await expect(flow.choose(ready, save)).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(flow.getState().phase).toBe('idle');
  });

  it('asks when it is not ready, and saves only after the install made it ready', async () => {
    const flow = createRequirementFlow();
    const save = vi.fn();
    const item = requirement();
    const chosen = flow.choose(item, save);
    await tick();
    expect(flow.getState().phase).toBe('asking');
    expect(flow.getState().requirement?.label).toBe('KittenTTS');
    expect(save).not.toHaveBeenCalled();

    const seen: (number | undefined)[] = [];
    flow.subscribe(() => seen.push(flow.getState().progress?.received));
    await flow.install();
    await expect(chosen).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(seen).toContain(14);
    expect(flow.getState().phase).toBe('idle');
  });

  it('keeps the old choice on cancel, also mid-install', async () => {
    const flow = createRequirementFlow();
    const save = vi.fn();
    let aborted = false;
    const item = requirement({
      install: (_progress, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('cancelled'));
          }),
        ),
    });
    const chosen = flow.choose(item, save);
    await tick();
    void flow.install();
    expect(flow.getState().phase).toBe('installing');
    flow.cancel();
    await expect(chosen).resolves.toBe(false);
    await tick();
    expect(aborted).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(flow.getState().phase).toBe('idle');
  });

  it('does not save when the install fails or the thing still is not there, and can try again', async () => {
    const flow = createRequirementFlow({ notReady: 'not there' });
    const save = vi.fn();
    let attempts = 0;
    const item = requirement({
      install: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
      },
    });
    const chosen = flow.choose(item, save);
    await tick();
    await flow.install();
    expect(flow.getState()).toMatchObject({ phase: 'failed', error: 'network down' });
    // The second install "succeeds" but the requirement still reads as missing
    await flow.install();
    expect(flow.getState()).toMatchObject({ phase: 'failed', error: 'not there' });
    expect(save).not.toHaveBeenCalled();
    item.ready = true;
    await flow.install();
    await expect(chosen).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('checks again for what the user sets up themselves', async () => {
    const flow = createRequirementFlow({ notReady: 'not yet' });
    const save = vi.fn();
    const item = requirement({ install: undefined, steps: ['Turn the flag on'] });
    const chosen = flow.choose(item, save);
    await tick();
    expect(flow.getState().phase).toBe('asking');
    await flow.install();
    expect(flow.getState().phase).toBe('asking');
    await flow.recheck();
    expect(flow.getState()).toMatchObject({ phase: 'failed', error: 'not yet' });
    item.ready = true;
    await flow.recheck();
    await expect(chosen).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('drops an earlier waiting choice when another is made', async () => {
    const flow = createRequirementFlow();
    const first = vi.fn();
    const second = vi.fn();
    const earlier = flow.choose(requirement({ id: 'kokoro' }), first);
    await tick();
    const ready = requirement();
    ready.ready = true;
    await expect(flow.choose(ready, second)).resolves.toBe(true);
    await expect(earlier).resolves.toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('shows a failed save instead of losing it', async () => {
    const flow = createRequirementFlow();
    const item = requirement();
    item.ready = true;
    void flow.choose(item, () => Promise.reject(new Error('storage full')));
    await tick();
    await tick();
    expect(flow.getState()).toMatchObject({ phase: 'failed', error: 'storage full' });
  });
});
