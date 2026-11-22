import { beforeEach, describe, expect, it, vi } from 'vitest';

// base.ts reads globalThis.chrome when it is imported, so the mock must exist before the import
const data = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(store, items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return store;
});

const sent = vi.hoisted(() => ({ init: vi.fn(), span: vi.fn(), flush: vi.fn() }));
vi.mock('suture-trace', () => ({
  initSuture: sent.init,
  flushSuture: sent.flush,
  suture: async (feature: string, fn: () => unknown) => {
    sent.span(feature);
    return fn();
  },
}));

const { tracingSettingsStore, DEFAULT_TRACING_SETTINGS } = await import('@extension/storage');

async function load() {
  vi.resetModules();
  return import('../suture');
}

describe('hosted Suture tracing', () => {
  beforeEach(() => {
    for (const key of Object.keys(data)) delete data[key];
    vi.unstubAllEnvs();
    sent.init.mockClear();
    sent.span.mockClear();
    sent.flush.mockClear();
  });

  it('is off by default, content included', () => {
    expect(DEFAULT_TRACING_SETTINGS).toEqual({ hostedEnabled: false, captureContent: false });
  });

  it('sends nothing with a key but the setting off', async () => {
    vi.stubEnv('VITE_SUTURE_API_KEY', 'sut_ing_test');
    const { tracedCall, flushHostedTracing } = await load();
    const run = vi.fn(async () => 'answer');
    expect(await tracedCall('ava-planner', run, [])).toBe('answer');
    await flushHostedTracing();
    expect(run).toHaveBeenCalledTimes(1);
    expect(sent.init).not.toHaveBeenCalled();
    expect(sent.span).not.toHaveBeenCalled();
    expect(sent.flush).not.toHaveBeenCalled();
  });

  it('sends nothing with the setting on but no key', async () => {
    vi.stubEnv('VITE_SUTURE_API_KEY', '');
    await tracingSettingsStore.updateSettings({ hostedEnabled: true });
    const { tracedCall } = await load();
    expect(await tracedCall('ava-navigator', async () => 1, [])).toBe(1);
    expect(sent.init).not.toHaveBeenCalled();
    expect(sent.span).not.toHaveBeenCalled();
  });

  it('traces with both, and keeps prompt text out unless asked', async () => {
    vi.stubEnv('VITE_SUTURE_API_KEY', 'sut_ing_test');
    await tracingSettingsStore.updateSettings({ hostedEnabled: true });
    const { tracedCall } = await load();
    await tracedCall('ava-planner', async () => 1, []);
    expect(sent.span).toHaveBeenCalledWith('ava-planner');
    expect(sent.init).toHaveBeenCalledWith(expect.objectContaining({ captureContent: false }));
  });

  it('stops again when the setting is switched off', async () => {
    vi.stubEnv('VITE_SUTURE_API_KEY', 'sut_ing_test');
    await tracingSettingsStore.updateSettings({ hostedEnabled: true });
    const { tracedCall } = await load();
    await tracedCall('ava-planner', async () => 1, []);
    await tracingSettingsStore.updateSettings({ hostedEnabled: false });
    await tracedCall('ava-planner', async () => 1, []);
    expect(sent.span).toHaveBeenCalledTimes(1);
  });
});
