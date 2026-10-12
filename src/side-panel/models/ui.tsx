import type { ReactNode } from 'react';
import { cn } from '@extension/ui';
import { t } from '@extension/i18n';
import type { ProviderHealthStatus } from '@extension/storage';

/** A titled glass card, as in Settings. */
export function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
        <h3 className="label-mono">{label}</h3>
        {action}
      </div>
      <div className="glass divide-border/60 divide-y overflow-hidden rounded-2xl">{children}</div>
    </section>
  );
}

/** A health light: mint when answering, red when not, grey when not checked. */
export function HealthDot({ status, className }: { status: ProviderHealthStatus | null; className?: string }) {
  const label =
    status === 'ok'
      ? t('models_health_ok')
      : status === 'error'
        ? t('models_health_error')
        : t('models_health_unknown');
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        status === 'ok' && 'bg-primary shadow-[0_0_8px_rgb(var(--primary-rgb))]',
        status === 'error' && 'bg-destructive',
        (status === 'unknown' || status === null) && 'bg-muted-foreground/50',
        className,
      )}
    />
  );
}

/** A row of mutually exclusive choices, for filters and chart dimensions. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="bg-muted/60 inline-flex flex-wrap gap-0.5 rounded-full p-0.5">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-full px-2.5 py-0.5 text-[11.5px] transition-colors',
            value === option.value
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export const inputClass =
  'w-full min-w-0 rounded-lg border bg-card px-2 py-1 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50';

export const formatUsd = (amount: number): string => (amount > 0 && amount < 0.01 ? '<$0.01' : `$${amount.toFixed(2)}`);

export const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k`
      : `${tokens}`;

/** A price per million tokens: "$0.30", or fewer digits for big ones. */
export const formatPrice = (usdPerM: number): string =>
  usdPerM === 0 ? '$0' : usdPerM < 1 ? `$${usdPerM.toFixed(2)}` : `$${Number(usdPerM.toFixed(2))}`;

/** "5 min ago", in the browser's language. */
export function timeAgo(at: number, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(chrome.i18n?.getUILanguage?.() ?? 'en', { numeric: 'auto' });
  const seconds = Math.round((at - now) / 1000);
  if (Math.abs(seconds) < 60) return format.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return format.format(hours, 'hour');
  return format.format(Math.round(hours / 24), 'day');
}
