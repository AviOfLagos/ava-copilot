import { forwardRef } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import type {
  DropdownMenuContentProps,
  DropdownMenuItemProps,
  DropdownMenuSeparatorProps,
  DropdownMenuTriggerProps,
} from '@radix-ui/react-dropdown-menu';
import { cn } from '@extension/ui';

/**
 * The one floating menu used everywhere in the panel: a chat row's "⋯", the profile button, and
 * anywhere else that needs a small list of actions. Built on Radix's dropdown menu so it gets a
 * portal (never clipped by a scrolling list), a solid blurred surface, collision-aware placement,
 * and Esc / click-outside / focus / arrow keys for free.
 */
export const RowMenu = Dropdown.Root;
export const RowMenuGroup = Dropdown.Group;
export const RowMenuLabel = Dropdown.Label;

export const RowMenuTrigger = forwardRef<HTMLButtonElement, DropdownMenuTriggerProps>(
  ({ className, ...props }, ref) => <Dropdown.Trigger ref={ref} className={cn('outline-none', className)} {...props} />,
);
RowMenuTrigger.displayName = 'RowMenuTrigger';

export const RowMenuContent = forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  ({ className, sideOffset = 6, collisionPadding = 8, align = 'end', ...props }, ref) => (
    <Dropdown.Portal>
      <Dropdown.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={collisionPadding}
        className={cn(
          'bg-popover text-popover-foreground border-border/60 z-50 min-w-[180px] overflow-hidden rounded-xl border p-1 shadow-2xl backdrop-blur-xl',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          'data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          'data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1',
          className,
        )}
        {...props}
      />
    </Dropdown.Portal>
  ),
);
RowMenuContent.displayName = 'RowMenuContent';

export interface RowMenuItemProps extends DropdownMenuItemProps {
  destructive?: boolean;
}

export const RowMenuItem = forwardRef<HTMLDivElement, RowMenuItemProps>(({ className, destructive, ...props }, ref) => (
  <Dropdown.Item
    ref={ref}
    className={cn(
      'flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] outline-none',
      'focus:bg-accent data-[highlighted]:bg-accent',
      destructive ? 'text-destructive' : 'text-foreground',
      className,
    )}
    {...props}
  />
));
RowMenuItem.displayName = 'RowMenuItem';

export const RowMenuSeparator = forwardRef<HTMLDivElement, DropdownMenuSeparatorProps>(
  ({ className, ...props }, ref) => (
    <Dropdown.Separator ref={ref} className={cn('bg-border/60 my-1 h-px', className)} {...props} />
  ),
);
RowMenuSeparator.displayName = 'RowMenuSeparator';
