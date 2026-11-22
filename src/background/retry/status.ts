/**
 * What the user sees while Ava waits to try something again: a short line with a countdown. It lives on the thread
 * (`retrying`) and is cleared as soon as the wait is over, so it is never a chat message that stays behind.
 */
export type RetryKind = 'step' | 'planning' | 'model' | 'repair' | 'fallback';

export interface RetryStatus {
  kind: RetryKind;
  /** When the next try starts (ms since epoch); absent while the retry is already running */
  until?: number;
  /** The try that is coming, counted from 1, and how many are allowed */
  attempt?: number;
  max?: number;
}

/** Sends a status to whoever shows it; null clears it. */
export type RetryReporter = (status: RetryStatus | null) => void;

const KINDS: RetryKind[] = ['step', 'planning', 'model', 'repair', 'fallback'];

/** The event's details: JSON for a status, empty to clear. */
export function encodeRetryStatus(status: RetryStatus | null): string {
  return status ? JSON.stringify(status) : '';
}

export function decodeRetryStatus(details: string): RetryStatus | null {
  if (!details) return null;
  try {
    const value = JSON.parse(details) as Partial<RetryStatus> | null;
    if (!value || !KINDS.includes(value.kind as RetryKind)) return null;
    const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);
    return { kind: value.kind as RetryKind, until: num(value.until), attempt: num(value.attempt), max: num(value.max) };
  } catch {
    return null;
  }
}

/**
 * Shows `status` while `wait` runs and clears it after, even when the wait throws.
 * `report` may be missing (a model used outside a chat): the wait then runs without a status.
 */
export async function whileRetrying<T>(
  report: RetryReporter | undefined,
  status: RetryStatus,
  wait: () => Promise<T>,
): Promise<T> {
  report?.(status);
  try {
    return await wait();
  } finally {
    report?.(null);
  }
}
