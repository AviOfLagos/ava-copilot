import type { HTMLAttributes } from 'react';
import { cn } from '@extension/ui';

const VARIANTS = {
  default: 'border-primary/30 bg-primary/10 text-foreground',
  secondary: 'border-border bg-secondary text-secondary-foreground',
  outline: 'border-input text-muted-foreground',
  hold: 'border-hold/45 bg-hold/10 text-hold-foreground',
  call: 'border-call/40 bg-call/10 text-foreground',
} as const;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: keyof typeof VARIANTS;
}

/** A small mono label: sources, statuses, skills. */
export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10.5px]',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
