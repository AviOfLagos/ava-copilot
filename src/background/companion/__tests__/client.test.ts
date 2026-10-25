import { describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const { installChromeStub } = await import('./chrome-stub');
  installChromeStub();
});

import { AppError } from '@extension/shared';
import type { SessionEvent } from '@src/shared/lib/protocol/companion';
import { CompanionClient, NOT_RUNNING_MESSAGE } from '../client';
import type { CompanionClientDeps } from '../client';

const health = {
  ok: true,
  protocol: 1,
  version: '0.1.0',
  companionId: 'mac-1',
  uptimeMs: 10,
  docker: { state: 'up', message: 'Docker is running.', version: '29.7.0', imageReady: true },
  engine: { kind: 'eve', state: 'ready', message: null },
  mcp: [],
  workflows: { active: 0, running: 0 },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  token: string | null = 'tok-123',
) {
  const calls: { url: string; init: RequestInit }[] = [];
  let snapshot: ReturnType<CompanionClientDeps['breakerState']['load']> extends Promise<infer T> ? T : never;
  const deps: CompanionClientDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return responder(String(input), init ?? {});
    }) as typeof fetch,
    port: async () => 47615,
    token: async () => token,
    breakerState: { load: async () => snapshot, save: async value => void (snapshot = value) },
    // No real waiting in tests
    retry: { baseMs: 1, capMs: 2, sleep: async () => {} },
  };
  return { client: new CompanionClient(deps), calls };
}

describe('CompanionClient', () => {
  it('speaks to 127.0.0.1 with the token, without cookies or redirects', async () => {
    const { client: brain, calls } = client(() => json(health));
    expect((await brain.health()).companionId).toBe('mac-1');
    expect(calls[0].url).toBe('http://127.0.0.1:47615/v1/health');
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer tok-123' });
    expect(calls[0].init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
    // A read is a POST too: the browser adds Origin to a POST, never to an extension's GET
    expect(calls[0].init).toMatchObject({ method: 'POST', body: JSON.stringify({ fresh: false }) });
  });

  it('refuses to call without a token', async () => {
    const { client: brain, calls } = client(() => json(health), null);
    await expect(brain.health()).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toHaveLength(0);
  });

  it('retries a read that may pass, but sends a side effect once', async () => {
    let tries = 0;
    const { client: reads } = client(() =>
      ++tries < 3
        ? json({ ok: false, error: { kind: 'unavailable', message: 'Starting' } }, 503)
        : json({ ok: true, artifacts: [] }),
    );
    await expect(reads.listArtifacts()).resolves.toEqual({ ok: true, artifacts: [] });
    expect(tries).toBe(3);

    const { client: writes, calls } = client(() =>
      json({ ok: false, error: { kind: 'unavailable', message: 'Docker is not running.' } }, 503),
    );
    await expect(
      writes.runSandbox({ requestId: 'run-1:step', profileId: 'routines', command: 'ls' }),
    ).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'Docker is not running.',
    });
    expect(calls).toHaveLength(1);
  });

  it('says plainly when Ava Brain is not running', async () => {
    const { client: brain } = client(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      brain.runSandbox({ requestId: 'run-1:step', profileId: 'routines', command: 'ls' }),
    ).rejects.toMatchObject({
      kind: 'network',
      message: NOT_RUNNING_MESSAGE,
    });
  });

  it('stops calling a companion that keeps failing (breaker), until a check by hand', async () => {
    const { client: brain, calls } = client(() => {
      throw new TypeError('Failed to fetch');
    });
    for (let i = 0; i < 5; i++) {
      await brain.runSandbox({ requestId: `run-${i}:step`, profileId: 'routines', command: 'ls' }).catch(() => {});
    }
    const before = calls.length;
    await expect(
      brain.runSandbox({ requestId: 'run-9:step', profileId: 'routines', command: 'ls' }),
    ).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(calls.length).toBe(before);
    await brain.health({ bypassBreaker: true }).catch(() => {});
    expect(calls.length).toBeGreaterThan(before);
  });

  it('refuses an answer it does not understand', async () => {
    const { client: brain } = client(() => json({ ok: true, something: 'else' }));
    await expect(brain.health()).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('opens only Avi Studio addresses on the companion itself', async () => {
    const { client: good } = client(() =>
      json({ ok: true, url: 'http://127.0.0.1:47615/studio/abcdef0123456789#token' }),
    );
    await expect(good.openArtifact('abcdef0123456789')).resolves.toBe(
      'http://127.0.0.1:47615/studio/abcdef0123456789#token',
    );
    const { client: bad } = client(() => json({ ok: true, url: 'https://evil.example/studio/x#token' }));
    await expect(bad.openArtifact('abcdef0123456789')).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('follows a session and picks a dropped stream up from the next event', async () => {
    const all: SessionEvent[] = [
      { type: 'session.started', index: 0 },
      { type: 'turn.started', index: 1, turnId: 't' },
      { type: 'message', index: 2, turnId: 't', text: 'done', final: true },
      { type: 'turn.completed', index: 3, turnId: 't' },
    ];
    const cursors: number[] = [];
    const { client: brain } = client((url, init) => {
      expect(init.method).toBe('POST');
      const cursor = Number(JSON.parse(String(init.body)).cursor);
      cursors.push(cursor);
      // The first connection drops after two events
      const events = cursor === 0 ? all.slice(0, 2) : all.filter(event => event.index >= cursor);
      return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', {
        headers: { 'content-type': 'application/x-ndjson' },
      });
    });
    const seen: SessionEvent[] = [];
    const next = await brain.followSession('wrun_1', {
      signal: new AbortController().signal,
      onEvent: event => void seen.push(event),
      until: event => event.type === 'turn.completed',
    });
    expect(seen.map(event => event.index)).toEqual([0, 1, 2, 3]);
    expect(cursors).toEqual([0, 2]);
    expect(next).toBe(4);
  });

  it('turns an error reply into the same AppError kind', async () => {
    const { client: brain } = client(() =>
      json({ ok: false, error: { kind: 'rate_limit', message: 'Wait', retryAfterMs: 1500 } }, 429),
    );
    const error = await brain
      .gh({ requestId: 'gh-12345', args: ['issue', 'list'], approved: false })
      .catch(caught => caught);
    expect(AppError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ kind: 'rate_limit', retryAfterMs: 1500, status: 429 });
  });
});
