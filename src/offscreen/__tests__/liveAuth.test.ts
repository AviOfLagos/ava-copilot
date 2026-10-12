import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveSocketUrl } from '../liveAuth';

afterEach(() => vi.unstubAllGlobals());

describe('liveSocketUrl', () => {
  it('asks the background for a one-use token, so the key never reaches the page', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, token: 'auth_tokens/abc', endpoint: 'wss://g/constrained' }));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const url = await liveSocketUrl({ endpoint: 'wss://g/live', apiKey: '', tokenAuth: true });
    expect(url).toBe('wss://g/constrained?access_token=auth_tokens%2Fabc');
    expect(url).not.toContain('key=');
    expect(sendMessage).toHaveBeenCalledWith({ type: 'models_live_token' });
  });

  it('keeps the key for a test endpoint, and says why when no token comes', async () => {
    expect(await liveSocketUrl({ endpoint: 'ws://127.0.0.1:1/ws', apiKey: 'k' })).toBe('ws://127.0.0.1:1/ws?key=k');
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: async () => ({ ok: false, error: 'Voice needs a Gemini API key.' }) },
    });
    await expect(liveSocketUrl({ endpoint: 'wss://g', apiKey: '', tokenAuth: true })).rejects.toThrow('Gemini API key');
  });
});
