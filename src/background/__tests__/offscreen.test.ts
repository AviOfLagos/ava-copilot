import { describe, expect, it, vi } from 'vitest';

// Chrome's rule: a second createDocument while one is open throws
let open = 0;
const createDocument = vi.fn(async () => {
  await new Promise(resolve => setTimeout(resolve, 10));
  if (open > 0) throw new Error('Only a single offscreen document may be created.');
  open++;
});
vi.stubGlobal('chrome', {
  runtime: {
    ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
    getContexts: async () => Array.from({ length: open }, () => ({})),
    sendMessage: async () => ({}),
  },
  offscreen: { createDocument, Reason: { USER_MEDIA: 'USER_MEDIA', AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' } },
});
vi.mock('@extension/storage', () => ({ audioDeviceSettingsStore: { getSettings: async () => ({}) } }));
vi.mock('../registry', () => ({ offscreenBusyAnywhere: async () => false }));

const { ensureOffscreen } = await import('../offscreen');

describe('ensureOffscreen', () => {
  it('opens one document when several callers ask at once', async () => {
    await expect(Promise.all([ensureOffscreen(), ensureOffscreen(), ensureOffscreen()])).resolves.toBeDefined();
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(open).toBe(1);
  });

  it('treats a document opened elsewhere meanwhile as open', async () => {
    open = 0;
    createDocument.mockImplementationOnce(async () => {
      open = 1;
      throw new Error('Only a single offscreen document may be created.');
    });
    await expect(ensureOffscreen()).resolves.toBeUndefined();
  });
});
