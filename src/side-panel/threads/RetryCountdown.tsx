import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import type { RetryStatus } from '@src/background/retry/status';
import { needsTicking, retryLine } from './countdown';

/** The current time, updated every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** One line under the thread's bar saying that Ava is waiting to try again, and for how long. */
export function RetryCountdown({ status }: { status: RetryStatus | null | undefined }) {
  const ticking = !!status?.until;
  const now = useNow(ticking);
  const line = retryLine(status, now, t);
  if (!line) return null;
  return (
    <div role="status" className="text-muted-foreground flex items-center gap-1.5 px-1 text-[12px] tabular-nums">
      <span className="bg-primary size-1.5 animate-pulse rounded-full" aria-hidden />
      <span>{line}</span>
    </div>
  );
}

export { needsTicking };
