import { cn } from '@extension/ui';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

/** An on/off switch: mint when on. */
export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-[34px] shrink-0 rounded-full border transition-colors disabled:opacity-50',
        checked ? 'border-primary/70 bg-primary/35' : 'border-input bg-muted',
      )}>
      <span
        className={cn(
          'absolute top-[2px] size-3.5 rounded-full transition-all',
          checked ? 'left-[16px] bg-foreground' : 'left-[2px] bg-muted-foreground',
        )}
      />
    </button>
  );
}
