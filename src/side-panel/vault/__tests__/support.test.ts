import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({}), set: async () => {}, onChanged: { addListener: () => {} } } },
    i18n: { getMessage: (key: string) => key },
  });
});

const { vaultSupport } = await import('../vault');

describe('whether the vault folder can be picked here', () => {
  it('is fine where the browser has a folder picker', () => {
    expect(vaultSupport({ showDirectoryPicker: async () => ({}) as FileSystemDirectoryHandle })).toBe('ok');
  });

  it('names Brave, which ships with the picker off behind a flag, so the panel can say how to turn it on', () => {
    expect(vaultSupport({ navigator: { brave: {} } })).toBe('brave_off');
  });

  it('says plainly when another browser has no picker at all', () => {
    expect(vaultSupport({ navigator: {} })).toBe('unsupported');
  });
});
