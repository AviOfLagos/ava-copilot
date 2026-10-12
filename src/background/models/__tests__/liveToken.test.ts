import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({}), set: async () => undefined, onChanged: { addListener: () => undefined } },
    },
  });
});

const { AUTH_TOKENS_URL, LIVE_CONSTRAINED_ENDPOINT, liveSocketUrl, mintLiveToken } = await import('../liveToken');
const { resetBreakers } = await import('../breakers');
import { fakeFetch, quickRetry } from './fakeFetch';

beforeEach(() => resetBreakers());

describe('Gemini Live tokens', () => {
  it('mints a one-use token with the key in a header, and connects with the token instead of the key', async () => {
    const { fetch, requests } = fakeFetch({ [AUTH_TOKENS_URL]: { json: { name: 'auth_tokens/abc123' } } });
    const now = Date.UTC(2026, 9, 12, 9, 0, 0);
    const token = await mintLiveToken('AIza-secret', { fetch, now: () => now });

    expect(requests[0]).toMatchObject({ url: AUTH_TOKENS_URL, method: 'POST' });
    expect(requests[0].headers.get('x-goog-api-key')).toBe('AIza-secret');
    expect(requests[0].body).toEqual({
      uses: 1,
      expireTime: '2026-10-12T09:30:00.000Z',
      newSessionExpireTime: '2026-10-12T09:01:00.000Z',
    });
    expect(token).toEqual({
      token: 'auth_tokens/abc123',
      endpoint: LIVE_CONSTRAINED_ENDPOINT,
      expiresAt: now + 30 * 60_000,
      newSessionUntil: now + 60_000,
    });
    const url = liveSocketUrl(token);
    expect(url).toBe(`${LIVE_CONSTRAINED_ENDPOINT}?access_token=auth_tokens%2Fabc123`);
    expect(url).not.toContain('AIza');
    expect(url).toContain('v1beta.GenerativeService.BidiGenerateContentConstrained');
  });

  it('can lock a token to one Live model', async () => {
    const { fetch, requests } = fakeFetch({ [AUTH_TOKENS_URL]: { json: { name: 'auth_tokens/x' } } });
    await mintLiveToken('AIza-secret', { fetch, model: 'gemini-live-3-flash' });
    expect(requests[0].body).toMatchObject({ bidiGenerateContentSetup: { model: 'models/gemini-live-3-flash' } });
  });

  it('fails plainly when Google refuses the key, or answers without a token', async () => {
    const refused = fakeFetch({ [AUTH_TOKENS_URL]: { status: 401 } });
    await expect(mintLiveToken('bad', { fetch: refused.fetch, retryPolicy: quickRetry })).rejects.toMatchObject({
      kind: 'auth',
    });
    const odd = fakeFetch({ [AUTH_TOKENS_URL]: { json: { name: 'something-else' } } });
    await expect(mintLiveToken('AIza', { fetch: odd.fetch })).rejects.toThrow(/token/);
    await expect(mintLiveToken('  ')).rejects.toMatchObject({ kind: 'auth' });
  });
});
