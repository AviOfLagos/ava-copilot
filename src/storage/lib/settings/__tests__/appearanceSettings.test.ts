import { describe, expect, it, vi } from 'vitest';

// base.ts reads globalThis.chrome when it is imported, so the mock must exist before the import
const store = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
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

const {
  DEFAULT_APPEARANCE_SETTINGS,
  TEXT_SCALES,
  appearanceCss,
  appearanceSettingsStore,
  nearestTextScale,
  normalizeAppearance,
  resolveTheme,
  stepTextScale,
} = await import('../appearanceSettings');

describe('text scale', () => {
  it('snaps to the nearest step and falls back to normal', () => {
    expect(nearestTextScale(104)).toBe(100);
    expect(nearestTextScale(500)).toBe(130);
    expect(nearestTextScale(1)).toBe(85);
    expect(nearestTextScale('big')).toBe(100);
    expect(nearestTextScale(NaN)).toBe(100);
  });

  it('steps one at a time and stops at both ends', () => {
    expect(stepTextScale(100, 1)).toBe(110);
    expect(stepTextScale(100, -1)).toBe(90);
    expect(stepTextScale(130, 1)).toBe(130);
    expect(stepTextScale(85, -1)).toBe(85);
    expect(TEXT_SCALES[0]).toBe(85);
    expect(TEXT_SCALES[TEXT_SCALES.length - 1]).toBe(130);
  });
});

describe('normalizeAppearance', () => {
  it('turns anything stored into a valid record', () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    expect(normalizeAppearance({ theme: 'neon', density: 'tiny', textScale: 'x' })).toEqual(
      DEFAULT_APPEARANCE_SETTINGS,
    );
    expect(normalizeAppearance({ theme: 'light', density: 'roomy', textScale: 118 })).toEqual({
      theme: 'light',
      density: 'roomy',
      textScale: 120,
    });
  });
});

describe('appearanceCss', () => {
  it('resolves system to what the system prefers', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('gives the zoom and the spacing factor', () => {
    expect(appearanceCss({ theme: 'dark', textScale: 130, density: 'compact' }, false)).toEqual({
      theme: 'dark',
      zoom: '1.3',
      density: '0.85',
    });
    expect(appearanceCss(DEFAULT_APPEARANCE_SETTINGS, false).zoom).toBe('1');
  });
});

describe('appearanceSettingsStore', () => {
  it('starts from the defaults and keeps what was updated', async () => {
    expect(await appearanceSettingsStore.getSettings()).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    await appearanceSettingsStore.updateSettings({ density: 'compact' });
    await appearanceSettingsStore.updateSettings({ theme: 'system' });
    expect(await appearanceSettingsStore.getSettings()).toEqual({
      theme: 'system',
      textScale: 100,
      density: 'compact',
    });
  });

  it('steps the text size and reports the new size', async () => {
    await appearanceSettingsStore.resetToDefaults();
    expect(await appearanceSettingsStore.stepText(1)).toBe(110);
    expect(await appearanceSettingsStore.stepText(1)).toBe(120);
    expect((await appearanceSettingsStore.getSettings()).textScale).toBe(120);
    for (let i = 0; i < 5; i++) await appearanceSettingsStore.stepText(1);
    expect(await appearanceSettingsStore.stepText(1)).toBe(130);
  });

  it('does not lose steps or other fields when writes overlap', async () => {
    await appearanceSettingsStore.resetToDefaults();
    await Promise.all([
      appearanceSettingsStore.stepText(1),
      appearanceSettingsStore.stepText(1),
      appearanceSettingsStore.updateSettings({ theme: 'light' }),
    ]);
    expect(await appearanceSettingsStore.getSettings()).toEqual({
      theme: 'light',
      textScale: 120,
      density: 'comfortable',
    });
  });

  it('repairs a bad stored record on read', async () => {
    store['appearance-settings'] = { theme: 'blue', textScale: 9999 };
    expect(await appearanceSettingsStore.getSettings()).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, textScale: 130 });
  });
});
