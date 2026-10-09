/*
 * Ported from AI Elements (https://github.com/vercel/ai-elements), Copyright 2023 Vercel, Inc.,
 * Apache License 2.0. Changed: imports, the panel's tokens, and the transcript download removed.
 */
import { ArrowDownIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { useCallback } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { cn } from '@extension/ui';
import { Button } from '../ui/button';

export type ConversationProps = ComponentProps<typeof StickToBottom>;

/** A scrolling log that sticks to the newest message unless the user scrolls up. */
export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-hidden', className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn('flex flex-col gap-6 px-3 py-4', className)} {...props} />
);

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title?: string;
  description?: string;
  icon?: ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title,
  description,
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn('flex size-full flex-col items-center justify-center gap-3 p-8 text-center', className)}
    {...props}>
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          {title && <h3 className="text-sm font-medium">{title}</h3>}
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({ className, ...props }: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const handleScrollToBottom = useCallback(() => {
    void scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn('absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full', className)}
        onClick={handleScrollToBottom}
        size="icon"
        variant="glass"
        {...props}>
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};
