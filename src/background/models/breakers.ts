import { CircuitBreaker } from '@extension/shared';

/**
 * One circuit breaker per provider host, so a provider that keeps failing is left alone for a while instead
 * of being asked again on every refresh. State lives in `storage.session`: a restarted background still knows
 * a host is down, and a browser restart starts clean.
 */

const STORAGE_KEY = 'model-breakers';

type Snapshot = ReturnType<CircuitBreaker['snapshot']>;

const breakers = new Map<string, CircuitBreaker>();
let restored: Promise<void> | null = null;

function sessionArea(): chrome.storage.StorageArea | undefined {
  return globalThis.chrome?.storage?.session;
}

async function restore(): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  const stored = ((await area.get(STORAGE_KEY).catch(() => ({}))) as Record<string, unknown>)[STORAGE_KEY];
  for (const [host, snapshot] of Object.entries((stored ?? {}) as Record<string, Snapshot>)) {
    if (breakers.has(host) || !Array.isArray(snapshot?.failures)) continue;
    const breaker = new CircuitBreaker();
    breaker.restore(snapshot);
    breakers.set(host, breaker);
  }
}

export async function breakerFor(host: string): Promise<CircuitBreaker> {
  restored ??= restore();
  await restored;
  let breaker = breakers.get(host);
  if (!breaker) {
    breaker = new CircuitBreaker();
    breakers.set(host, breaker);
  }
  return breaker;
}

export async function saveBreakers(): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  const snapshot = Object.fromEntries([...breakers].map(([host, breaker]) => [host, breaker.snapshot()]));
  await area.set({ [STORAGE_KEY]: snapshot }).catch(() => {});
}

/** Hosts whose breaker is open now: calls to them fail fast. */
export async function openHosts(now = Date.now()): Promise<Set<string>> {
  restored ??= restore();
  await restored;
  return new Set([...breakers].filter(([, breaker]) => breaker.state(now) === 'open').map(([host]) => host));
}

/** Forgets every breaker; for tests. */
export function resetBreakers(): void {
  breakers.clear();
  restored = null;
}
