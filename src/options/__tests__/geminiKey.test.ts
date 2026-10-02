import { describe, expect, it, vi } from 'vitest';
import { checkGeminiKey } from '../geminiKey';

const respond = (status: number, body: unknown = {}) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

describe('checkGeminiKey', () => {
  it('returns the model ids of a working key and sends the key as a header', async () => {
    const fetchFn = respond(200, {
      models: [{ name: 'models/gemini-3.8-flash' }, { name: 'models/gemini-embedding-001' }],
    });

    expect(await checkGeminiKey('good-key', fetchFn)).toEqual({
      status: 'valid',
      modelIds: ['gemini-3.8-flash', 'gemini-embedding-001'],
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).not.toContain('good-key');
    expect(init?.headers).toEqual({ 'x-goog-api-key': 'good-key' });
  });

  it.each([400, 401, 403])('reports a key Google refuses with %i as rejected', async status => {
    expect(await checkGeminiKey('bad-key', respond(status))).toEqual({ status: 'rejected' });
  });

  it('does not judge the key when the check itself fails', async () => {
    expect(await checkGeminiKey('key', respond(503))).toEqual({ status: 'unknown' });
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await checkGeminiKey('key', offline)).toEqual({ status: 'unknown' });
  });

  it('treats a response without models as a working key with no models', async () => {
    expect(await checkGeminiKey('key', respond(200, {}))).toEqual({ status: 'valid', modelIds: [] });
  });
});
