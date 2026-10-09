import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@extension/ui';

const VARIANTS = {
  // The main action: a mint glass pill with a lit edge
  default:
    'border border-primary/55 bg-gradient-to-b from-primary/30 to-primary/10 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_0_18px_rgb(var(--primary-rgb)/0.22)] hover:from-primary/40 hover:to-primary/15',
  // A frosted surface for everything secondary
  glass: 'glass text-foreground hover:bg-accent',
  outline: 'border border-input bg-transparent text-foreground hover:bg-accent',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
  ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
  // Only for steps that wait for the user's click
  hold: 'border border-hold bg-hold/15 font-semibold text-hold-foreground hover:bg-hold/25',
  destructive: 'border border-destructive/50 bg-destructive/15 text-foreground hover:bg-destructive/25',
} as const;

const SIZES = {
  default: 'h-9 rounded-full px-4 text-[13px]',
  sm: 'h-8 rounded-full px-3 text-xs',
  lg: 'h-10 rounded-xl px-5 text-sm',
  icon: 'size-8 rounded-[10px]',
  'icon-sm': 'size-7 rounded-lg',
} as const;

export type ButtonVariant = keyof typeof VARIANTS;
export type ButtonSize = keyof typeof SIZES;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function buttonClasses(variant: ButtonVariant = 'default', size: ButtonSize = 'default', className?: string) {
  return cn(
    'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-none transition-colors',
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

/** The panel's button. Its variants follow the colour jobs in docs/DIRECTION.md. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={buttonClasses(variant, size, className)} {...props} />
  ),
);
Button.displayName = 'Button';
