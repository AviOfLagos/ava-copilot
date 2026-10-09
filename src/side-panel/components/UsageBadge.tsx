import { useEffect, useSyncExternalStore } from 'react';
import { EMPTY_USAGE, localDay, usageStore } from '@extension/storage';
import { t } from '@extension/i18n';

interface UsageBadgeProps {
  sessionId: string | null;
  isDarkMode?: boolean;
}

const formatUsd = (amount: number): string => (amount > 0 && amount < 0.01 ? '<$0.01' : `$${amount.toFixed(2)}`);

const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${(tokens / 1000).toFixed(1)}k`
      : `${tokens}`;

/**
 * Shows what the current chat has cost so far, with the tokens and today's total on hover.
 */
export default function UsageBadge({ sessionId, isDarkMode = false }: UsageBadgeProps) {
  const record = useSyncExternalStore(usageStore.subscribe, usageStore.getSnapshot);

  // The snapshot is empty until the store has been read once
  useEffect(() => {
    void usageStore.get();
  }, []);

  const session = (sessionId && record?.sessions?.[sessionId]) || EMPTY_USAGE;
  const today = record?.days?.[localDay()] ?? EMPTY_USAGE;
  if (session.calls === 0) {
    return null;
  }

  const tokens = formatTokens(session.inputTokens + session.outputTokens);
  // A model with no known price has tokens but no cost
  const label = session.unpricedCalls === session.calls ? `${tokens} tok` : formatUsd(session.costUsd);

  return (
    <span
      title={t('usage_badge_title', [tokens, formatUsd(today.costUsd)])}
      data-usage
      data-dark={isDarkMode || undefined}
      className="text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10.5px] tabular-nums">
      {label}
    </span>
  );
}
