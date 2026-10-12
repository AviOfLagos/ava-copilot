import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '@extension/shared';

// The model setup reaches the browser automation, which loads the extension polyfill
vi.mock('webextension-polyfill', () => ({ default: {} }));
import type { RunRecord, WorkflowRecord } from '@extension/storage';
import { applyOverride, htmlToText, httpGetExecutor } from '../executors';
import type { HttpDeps } from '../executors';
import { morningTechNews } from '../templates';
import type { StepContext } from '../engine';

const spec = morningTechNews('UTC');
const run = { id: 'r1', spec } as unknown as RunRecord;
const workflow = { id: 'w1', name: 'News' } as unknown as WorkflowRecord;

function context(url: string, format: 'json' | 'text' = 'json', maxBytes = 1_000_000): StepContext {
  const node = { id: 'hn', type: 'step.http_get', label: 'HN', url, format, maxBytes } as const;
  return {
    node,
    params: { ...node },
    run,
    workflow,
    state: null,
    saveState: async () => {},
    signal: new AbortController().signal,
  };
}

function deps(responder: (url: string, init?: RequestInit) => Response, overrides: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const breaker = new CircuitBreaker();
  const value: HttpDeps = {
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      return responder(url, init);
    },
    overrides: async () => overrides,
    breaker: async () => breaker,
  };
  return { value, calls };
}

describe('step.http_get', () => {
  it('fetches JSON without cookies and passes it on compacted', async () => {
    const { value, calls } = deps(
      () =>
        new Response(JSON.stringify({ hits: [{ title: 'Story', _highlightResult: { big: 1 } }] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const outcome = await httpGetExecutor(value).execute(
      context('https://hn.algolia.com/api/v1/search?tags=front_page'),
    );
    expect(outcome).toEqual({ kind: 'done', output: { hits: [{ title: 'Story' }] }, tainted: true });
    expect(calls[0].init).toMatchObject({ method: 'GET', credentials: 'omit' });
  });

  it('refuses hosts that are not on the list, and redirects that leave it', async () => {
    const { value } = deps(() => new Response('{}'));
    await expect(httpGetExecutor(value).execute(context('https://evil.example/steal'))).rejects.toMatchObject({
      kind: 'forbidden',
    });

    const redirected = deps(() => {
      const response = new Response('{}');
      Object.defineProperty(response, 'url', { value: 'https://elsewhere.example/x' });
      return response;
    });
    await expect(httpGetExecutor(redirected.value).execute(context('https://hn.algolia.com/x'))).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  it('says what a failed answer means, so only passing errors are retried', async () => {
    const limited = deps(() => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }));
    await expect(httpGetExecutor(limited.value).execute(context('https://hn.algolia.com/x'))).rejects.toMatchObject({
      kind: 'rate_limit',
      retryable: true,
      retryAfterMs: 3000,
    });
    const gone = deps(() => new Response('', { status: 404 }));
    await expect(httpGetExecutor(gone.value).execute(context('https://hn.algolia.com/x'))).rejects.toMatchObject({
      kind: 'not_found',
      retryable: false,
    });
    const notJson = deps(() => new Response('<html>hi</html>'));
    await expect(httpGetExecutor(notJson.value).execute(context('https://hn.algolia.com/x'))).rejects.toMatchObject({
      kind: 'invalid',
    });
  });

  it('caps the size: JSON past the cap fails, text is cut', async () => {
    const big = deps(() => new Response(JSON.stringify({ text: 'x'.repeat(5000) })));
    await expect(
      httpGetExecutor(big.value).execute(context('https://hn.algolia.com/x', 'json', 1000)),
    ).rejects.toMatchObject({
      kind: 'invalid',
    });
    const page = deps(
      () => new Response(`<p>${'word '.repeat(400)}</p>`, { headers: { 'content-type': 'text/html' } }),
    );
    const outcome = await httpGetExecutor(page.value).execute(context('https://hn.algolia.com/x', 'text', 1000));
    expect(outcome.kind === 'done' && String(outcome.output).length).toBeLessThanOrEqual(1000);
  });

  it('fetches a local stand-in only when a test override points at this machine', async () => {
    const local = deps(() => new Response('{"ok":true}'), { 'https://hn.algolia.com/': 'http://127.0.0.1:9999/hn/' });
    await httpGetExecutor(local.value).execute(context('https://hn.algolia.com/api/v1/search'));
    expect(local.calls[0].url).toBe('http://127.0.0.1:9999/hn/api/v1/search');

    expect(applyOverride('https://hn.algolia.com/a', { 'https://hn.algolia.com/': 'https://attacker.example/' })).toBe(
      'https://hn.algolia.com/a',
    );
  });
});

describe('htmlToText', () => {
  it('keeps the words of a page, without scripts, styles or tags', () => {
    const text = htmlToText(
      '<html><head><style>p{}</style><script>steal()</script></head><body><h1>Trending</h1><p>repo &amp; stars&nbsp;10</p><!-- note --></body></html>',
    );
    expect(text).toBe('Trending\nrepo & stars 10');
  });
});
