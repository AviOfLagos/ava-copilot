import { vi } from 'vitest';

export interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Answer = { status?: number; json?: unknown; headers?: Record<string, string> } | (() => Promise<Response>);

/**
 * A fetch that answers from a table of URL prefixes (longest first) and records every request.
 * A route with a list of answers gives them in turn and repeats the last.
 */
export function fakeFetch(routes: Record<string, Answer | Answer[]>) {
  const requests: Recorded[] = [];
  const served = new Map<string, number>();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    init?.signal?.throwIfAborted();
    const prefix = Object.keys(routes)
      .filter(key => url.startsWith(key))
      .sort((a, b) => b.length - a.length)[0];
    if (!prefix) return new Response('not found', { status: 404 });
    const route = routes[prefix];
    const list = Array.isArray(route) ? route : [route];
    const index = served.get(prefix) ?? 0;
    served.set(prefix, index + 1);
    const answer = list[Math.min(index, list.length - 1)];
    if (typeof answer === 'function') return answer();
    return new Response(answer.json === undefined ? '' : JSON.stringify(answer.json), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json', ...answer.headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

/** A network that is down: fetch rejects as the browser does. */
export const networkDown = () => Promise.reject(new TypeError('Failed to fetch'));

/** Retries without waiting, for tests. */
export const quickRetry = { sleep: async () => {}, random: () => 0 };
