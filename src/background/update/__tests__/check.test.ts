import { describe, expect, it } from 'vitest';
import { AppError } from '@extension/shared';
import { fetchVersionInfo, UPDATE_FEED_URL } from '../check';

const GOOD_BODY = {
  version: '1.4.0',
  released: '2026-10-22',
  notes: ['One thing that changed.'],
  extension: { url: 'https://ava.nexprove.com/install.sh', command: 'curl -fsSL https://x | bash' },
  brain: { version: '0.1.0', command: 'cd companion && pnpm install' },
};

function fakeFetch(respond: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetcher, calls };
}

const jsonResponse = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });

describe('fetchVersionInfo', () => {
  it('reads and validates a well-formed feed, sending no cookies or identifying headers', async () => {
    const { fetcher, calls } = fakeFetch(() => jsonResponse(GOOD_BODY));
    const info = await fetchVersionInfo({ fetch: fetcher, url: UPDATE_FEED_URL });
    expect(info).toEqual(GOOD_BODY);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(UPDATE_FEED_URL);
    expect(calls[0].init?.credentials).toBe('omit');
    expect(calls[0].init?.headers).toBeUndefined();
  });

  it('refuses a reply that does not match the schema', async () => {
    const { fetcher } = fakeFetch(() => jsonResponse({ version: 'not-a-version' }));
    await expect(fetchVersionInfo({ fetch: fetcher })).rejects.toBeInstanceOf(AppError);
  });

  it('refuses a reply that is too large, by content-length', async () => {
    const { fetcher } = fakeFetch(() => jsonResponse(GOOD_BODY, { 'content-length': '50000' }));
    await expect(fetchVersionInfo({ fetch: fetcher })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('refuses a reply that is too large, by actual body size (no content-length given)', async () => {
    const big = { ...GOOD_BODY, notes: Array.from({ length: 20 }, (_, i) => `note ${i}`.padEnd(2000, '.')) };
    const { fetcher } = fakeFetch(() => jsonResponse(big));
    await expect(fetchVersionInfo({ fetch: fetcher })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('refuses a non-OK response', async () => {
    const { fetcher } = fakeFetch(() => new Response('nope', { status: 500 }));
    await expect(fetchVersionInfo({ fetch: fetcher })).rejects.toBeInstanceOf(AppError);
  });

  it('refuses a body that is not valid JSON', async () => {
    const { fetcher } = fakeFetch(() => new Response('not json', { headers: { 'content-type': 'text/plain' } }));
    await expect(fetchVersionInfo({ fetch: fetcher })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('wraps a network failure as a network AppError', async () => {
    const fetcher = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(fetchVersionInfo({ fetch: fetcher })).rejects.toMatchObject({ kind: 'network' });
  });
});
