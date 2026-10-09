/*
 * Ported from AI Elements (https://github.com/vercel/ai-elements), Copyright 2023 Vercel, Inc.,
 * Apache License 2.0. Changed: imports, the panel's tokens, and the step drawn as a node on a wire
 * (after n8n's graph), with two more statuses: "held", a commit waiting for the user's click, and
 * "failed".
 */
import { useControllableState } from '@radix-ui/react-use-controllable-state';
import type { LucideIcon } from 'lucide-react';
import { ChevronDownIcon, DotIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, memo, useContext, useMemo } from 'react';
import { cn } from '@extension/ui';
import { Badge } from '../ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

interface ChainOfThoughtContextValue {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(null);

const useChainOfThought = () => {
  const context = useContext(ChainOfThoughtContext);
  if (!context) {
    throw new Error('ChainOfThought components must be used within ChainOfThought');
  }
  return context;
};

export type ChainOfThoughtProps = ComponentProps<'div'> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const ChainOfThought = memo(
  ({ className, open, defaultOpen = false, onOpenChange, children, ...props }: ChainOfThoughtProps) => {
    const [isOpen, setIsOpen] = useControllableState({ defaultProp: defaultOpen, onChange: onOpenChange, prop: open });
    const value = useMemo(() => ({ isOpen: Boolean(isOpen), setIsOpen }), [isOpen, setIsOpen]);
    return (
      <ChainOfThoughtContext.Provider value={value}>
        <div className={cn('glass w-full rounded-2xl px-3 py-2.5', className)} {...props}>
          {children}
        </div>
      </ChainOfThoughtContext.Provider>
    );
  },
);

export type ChainOfThoughtHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  /** Shown on the right, e.g. the run's duration. */
  meta?: ReactNode;
  icon?: ReactNode;
};

export const ChainOfThoughtHeader = memo(({ className, children, meta, icon, ...props }: ChainOfThoughtHeaderProps) => {
  const { isOpen, setIsOpen } = useChainOfThought();
  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground',
          className,
        )}
        {...props}>
        {icon}
        <span className="flex-1 text-left">{children}</span>
        {meta && <span className="font-mono text-[10.5px]">{meta}</span>}
        <ChevronDownIcon className={cn('size-4 transition-transform', isOpen ? 'rotate-180' : 'rotate-0')} />
      </CollapsibleTrigger>
    </Collapsible>
  );
});

export type StepStatus = 'complete' | 'active' | 'pending' | 'held' | 'failed';

export type ChainOfThoughtStepProps = ComponentProps<'div'> & {
  icon?: LucideIcon;
  label: ReactNode;
  description?: ReactNode;
  status?: StepStatus;
  /** The last node has no wire under it. */
  last?: boolean;
};

const labelStyles: Record<StepStatus, string> = {
  active: 'text-foreground',
  complete: 'text-foreground/85',
  pending: 'text-muted-foreground/60',
  held: 'text-hold-foreground',
  failed: 'text-foreground',
};

const nodeStyles: Record<StepStatus, string> = {
  complete: 'border-primary/50 bg-primary/15 text-primary',
  active: 'border-primary bg-primary/20 text-primary shadow-[0_0_12px_rgb(var(--primary-rgb)/0.45)]',
  pending: 'border-border bg-muted text-muted-foreground',
  held: 'border-hold bg-hold/20 text-hold shadow-[0_0_12px_rgb(var(--hold-rgb)/0.45)]',
  failed: 'border-destructive/60 bg-destructive/15 text-destructive',
};

const wireStyles: Record<StepStatus, string> = {
  complete: 'bg-primary/60',
  active: 'bg-gradient-to-b from-primary/70 to-border',
  pending: 'bg-border',
  held: 'bg-gradient-to-b from-hold/70 to-border',
  failed: 'bg-destructive/40',
};

/** One node of the run: an icon in a squircle, its wire down to the next node, and what happened. */
export const ChainOfThoughtStep = memo(
  ({
    className,
    icon: Icon = DotIcon,
    label,
    description,
    status = 'complete',
    last = false,
    children,
    ...props
  }: ChainOfThoughtStepProps) => (
    <div
      className={cn(
        'relative flex gap-2.5 pb-3 text-[13px] last:pb-0',
        'animate-in fade-in-0 slide-in-from-top-1',
        className,
      )}
      data-status={status}
      {...props}>
      <div className="relative flex w-6 shrink-0 justify-center">
        {status === 'held' ? (
          <span className="border-hold bg-hold/20 mt-1 size-[15px] rotate-45 rounded-[3px] border-[1.5px] shadow-[0_0_12px_rgb(var(--hold-rgb)/0.45)]" />
        ) : (
          <span className={cn('flex size-6 items-center justify-center rounded-lg border', nodeStyles[status])}>
            <Icon className={cn('size-3.5', status === 'active' && 'animate-pulse')} />
          </span>
        )}
        {!last && <span className={cn('absolute -bottom-3 top-[26px] w-px', wireStyles[status])} />}
      </div>
      <div className="min-w-0 flex-1 space-y-1 pt-[3px]">
        <div className={cn('break-words leading-snug', labelStyles[status])}>{label}</div>
        {description && <div className="text-muted-foreground font-mono text-[10.5px]">{description}</div>}
        {children}
      </div>
    </div>
  ),
);

export const ChainOfThoughtSearchResults = memo(({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('flex flex-wrap items-center gap-1.5', className)} {...props} />
));

export const ChainOfThoughtSearchResult = memo(({ className, children, ...props }: ComponentProps<typeof Badge>) => (
  <Badge className={cn('font-normal', className)} variant="secondary" {...props}>
    {children}
  </Badge>
));

export type ChainOfThoughtContentProps = ComponentProps<typeof CollapsibleContent>;

export const ChainOfThoughtContent = memo(({ className, children, ...props }: ChainOfThoughtContentProps) => {
  const { isOpen } = useChainOfThought();
  return (
    <Collapsible open={isOpen}>
      <CollapsibleContent
        className={cn(
          'mt-3 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          className,
        )}
        {...props}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
});

ChainOfThought.displayName = 'ChainOfThought';
ChainOfThoughtHeader.displayName = 'ChainOfThoughtHeader';
ChainOfThoughtStep.displayName = 'ChainOfThoughtStep';
ChainOfThoughtSearchResults.displayName = 'ChainOfThoughtSearchResults';
ChainOfThoughtSearchResult.displayName = 'ChainOfThoughtSearchResult';
ChainOfThoughtContent.displayName = 'ChainOfThoughtContent';
