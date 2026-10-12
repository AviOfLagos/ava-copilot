import { CircuitBreaker } from '@extension/shared';

/**
 * One circuit breaker per connector: a server that keeps failing is left alone for a while (5 failures in a
 * minute → 2 minutes off) instead of being called on every step. Kept in `storage.session`, so a restarted
 * background still knows a server is down and a browser restart starts clean.
 */

const STORAGE_KEY = 'connector-breakers';

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
  for (const [id, snapshot] of Object.entries((stored ?? {}) as Record<string, Snapshot>)) {
    if (breakers.has(id) || !Array.isArray(snapshot?.failures)) continue;
    const breaker = new CircuitBreaker();
    breaker.restore(snapshot);
    breakers.set(id, breaker);
  }
}

export async function connectorBreaker(connectorId: string): Promise<CircuitBreaker> {
  restored ??= restore();
  await restored;
  let breaker = breakers.get(connectorId);
  if (!breaker) {
    breaker = new CircuitBreaker();
    breakers.set(connectorId, breaker);
  }
  return breaker;
}

export async function saveConnectorBreakers(): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  const snapshot = Object.fromEntries([...breakers].map(([id, breaker]) => [id, breaker.snapshot()]));
  await area.set({ [STORAGE_KEY]: snapshot }).catch(() => {});
}

/** Forgets a removed connector's breaker. */
export async function dropConnectorBreaker(connectorId: string): Promise<void> {
  breakers.delete(connectorId);
  await saveConnectorBreakers();
}

/** Forgets every breaker; for tests. */
export function resetConnectorBreakers(): void {
  breakers.clear();
  restored = null;
}
