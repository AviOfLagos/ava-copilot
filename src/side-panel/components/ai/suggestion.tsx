/*
 * Ported from AI Elements (https://github.com/vercel/ai-elements), Copyright 2023 Vercel, Inc.,
 * Apache License 2.0. Changed: imports, a plain scrolling row instead of ScrollArea.
 */
import type { ComponentProps } from 'react';
import { useCallback } from 'react';
import { cn } from '@extension/ui';
import { Button } from '../ui/button';

export const Suggestions = ({ className, children, ...props }: ComponentProps<'div'>) => (
  <div className="w-full overflow-x-auto whitespace-nowrap [scrollbar-width:none]" {...props}>
    <div className={cn('flex w-max flex-nowrap items-center gap-2', className)}>{children}</div>
  </div>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = 'glass',
  size = 'sm',
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = useCallback(() => onClick?.(suggestion), [onClick, suggestion]);
  return (
    <Button
      className={cn('rounded-full px-3.5', className)}
      onClick={handleClick}
      size={size}
      variant={variant}
      {...props}>
      {children || suggestion}
    </Button>
  );
};
