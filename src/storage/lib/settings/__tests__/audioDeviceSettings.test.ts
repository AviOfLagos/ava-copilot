import { beforeEach, describe, expect, it, vi } from 'vitest';

// base.ts reads globalThis.chrome when it is imported, so the mock must exist before the import
const store = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(data, items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return data;
});

const { DEFAULT_AUDIO_DEVICE_SETTINGS, audioDeviceSettingsStore } = await import('../audioDeviceSettings');

describe('audioDeviceSettingsStore', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
  });

  it('starts on the system default for both mic and speaker', async () => {
    expect(await audioDeviceSettingsStore.getSettings()).toEqual(DEFAULT_AUDIO_DEVICE_SETTINGS);
  });

  it('persists a chosen device by id and label', async () => {
    await audioDeviceSettingsStore.updateSettings({ mic: { deviceId: 'id-1', label: 'USB Microphone' } });
    expect(await audioDeviceSettingsStore.getSettings()).toEqual({
      mic: { deviceId: 'id-1', label: 'USB Microphone' },
      speaker: null,
    });
  });

  it('merges changes, keeping the other field, and fills fields saved before they existed', async () => {
    store['audio-device-settings'] = { mic: { deviceId: 'id-1', label: 'USB Microphone' } };
    await audioDeviceSettingsStore.updateSettings({ speaker: { deviceId: 'id-2', label: 'USB Speakers' } });
    expect(store['audio-device-settings']).toEqual({
      mic: { deviceId: 'id-1', label: 'USB Microphone' },
      speaker: { deviceId: 'id-2', label: 'USB Speakers' },
    });
  });

  it('clears a choice back to the system default', async () => {
    await audioDeviceSettingsStore.updateSettings({ mic: { deviceId: 'id-1', label: 'USB Microphone' } });
    await audioDeviceSettingsStore.updateSettings({ mic: null });
    expect((await audioDeviceSettingsStore.getSettings()).mic).toBeNull();
  });
});
