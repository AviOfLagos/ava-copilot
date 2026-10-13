import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  assistantNameOf,
  checkAssistantName,
  chooseWakePhrase,
  loadWakeVocabulary,
  onboardingStore,
  parseVocabulary,
  wakeWordsOf,
} = await import('../assistant');
const { generalSettingsStore } = await import('../generalSettings');

describe('checkAssistantName', () => {
  it('trims and accepts letters, spaces, hyphens and apostrophes', () => {
    expect(checkAssistantName('  Nova ')).toEqual({ ok: true, name: 'Nova' });
    expect(checkAssistantName('Mary   Jane')).toEqual({ ok: true, name: 'Mary Jane' });
    expect(checkAssistantName('Jean-Luc')).toEqual({ ok: true, name: 'Jean-Luc' });
    expect(checkAssistantName('O’Brien')).toEqual({ ok: true, name: "O'Brien" });
    expect(checkAssistantName('Zoë')).toEqual({ ok: true, name: 'Zoë' });
    expect(checkAssistantName('小助手')).toEqual({ ok: true, name: '小助手' });
  });

  it('refuses empty, long and other characters', () => {
    expect(checkAssistantName('   ')).toEqual({ ok: false, problem: 'empty' });
    expect(checkAssistantName('a'.repeat(24)).ok).toBe(true);
    expect(checkAssistantName('a'.repeat(25))).toEqual({ ok: false, problem: 'tooLong' });
    for (const bad of ['R2D2', 'Ava!', 'ignore <instructions>', '-Ava', "'Ava", 'Ava.', 'a_b']) {
      expect(checkAssistantName(bad)).toEqual({ ok: false, problem: 'characters' });
    }
  });

  it('falls back to Ava for a stored name that is missing or invalid', () => {
    expect(assistantNameOf(undefined)).toBe('Ava');
    expect(assistantNameOf('')).toBe('Ava');
    expect(assistantNameOf('Bad$name')).toBe('Ava');
    expect(assistantNameOf(' Nova ')).toBe('Nova');
  });
});

describe('chooseWakePhrase', () => {
  const vocabulary = new Set(['hey', 'ava', 'nova', 'mary', 'jane', "o'brien"]);

  it('splits a name into the recogniser’s words', () => {
    expect(wakeWordsOf('Mary-Jane')).toEqual(['mary', 'jane']);
    expect(wakeWordsOf("O'Brien")).toEqual(["o'brien"]);
    expect(wakeWordsOf("Nova'")).toEqual(['nova']);
  });

  it('follows the name when the model knows every word', () => {
    expect(chooseWakePhrase('Nova', vocabulary)).toMatchObject({ phrase: 'hey nova', followsName: true });
    expect(chooseWakePhrase('Mary Jane', vocabulary)).toMatchObject({
      phrase: 'hey mary jane',
      words: ['mary', 'jane'],
    });
    expect(chooseWakePhrase("O'Brien", vocabulary).phrase).toBe("hey o'brien");
  });

  it('keeps "hey ava" for a word the model does not know, and says which', () => {
    expect(chooseWakePhrase('Zorblax', vocabulary)).toEqual({
      words: ['ava'],
      phrase: 'hey ava',
      followsName: false,
      missing: ['zorblax'],
      unchecked: false,
    });
    expect(chooseWakePhrase('Mary Zorblax', vocabulary).missing).toEqual(['zorblax']);
  });

  it('keeps "hey ava" when the vocabulary is not installed, but Ava itself still follows the name', () => {
    expect(chooseWakePhrase('Nova', null)).toMatchObject({ phrase: 'hey ava', followsName: false, unchecked: true });
    expect(chooseWakePhrase('Ava', null)).toMatchObject({ phrase: 'hey ava', followsName: true, unchecked: false });
    expect(chooseWakePhrase('', vocabulary)).toMatchObject({ phrase: 'hey ava', followsName: true });
  });

  it('reads words.txt, and gives null when it is missing', async () => {
    expect(parseVocabulary('hey\nava\n\n nova \n')).toEqual(new Set(['hey', 'ava', 'nova']));
    const fetch = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    expect(await loadWakeVocabulary()).toBeNull();
    fetch.mockImplementation(async () => new Response('hey\nava\nnova\n'));
    expect((await loadWakeVocabulary())?.has('nova')).toBe(true);
    expect(fetch).toHaveBeenCalledWith('chrome-extension://test/wake/words.txt');
  });
});

describe('settings', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
  });

  it('defaults the name to Ava, also for settings saved before it existed', async () => {
    expect((await generalSettingsStore.getSettings()).assistantName).toBe('Ava');
    store['general-settings'] = { maxSteps: 50 };
    expect((await generalSettingsStore.getSettings()).assistantName).toBe('Ava');
    await generalSettingsStore.updateSettings({ assistantName: 'Nova' });
    expect((await generalSettingsStore.getSettings()).assistantName).toBe('Nova');
  });

  it('shows onboarding until it is completed', async () => {
    expect((await onboardingStore.get()).completedAt).toBe(0);
    await onboardingStore.complete();
    expect((await onboardingStore.get()).completedAt).toBeGreaterThan(0);
  });
});
