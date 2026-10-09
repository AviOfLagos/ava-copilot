/*
 * Ported from AI Elements (https://github.com/vercel/ai-elements), Copyright 2023 Vercel, Inc.,
 * Apache License 2.0. Changed: imports, the panel's tokens, and Streamdown without its code, math,
 * mermaid and CJK plugins, which the panel does not need.
 */
import type { ComponentProps, HTMLAttributes } from 'react';
import { memo } from 'react';
import { Streamdown } from 'streamdown';
import { cn } from '@extension/ui';

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: 'user' | 'assistant' | 'system';
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full flex-col gap-2',
      from === 'user' ? 'is-user ml-auto max-w-[85%] items-end' : 'is-assistant max-w-full',
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

/** The user's words sit in a soft bubble; the copilot's answer is set as plain text. */
export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      'flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-[14px] leading-relaxed',
      'group-[.is-user]:rounded-[18px] group-[.is-user]:rounded-br-md group-[.is-user]:border group-[.is-user]:bg-secondary group-[.is-user]:px-3.5 group-[.is-user]:py-2.5',
      'group-[.is-assistant]:text-foreground',
      className,
    )}
    {...props}>
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<'div'>;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div
    className={cn(
      // Takes no room until the message is hovered or focused
      'flex h-0 items-center gap-1 overflow-hidden opacity-0 transition-all group-focus-within:h-7 group-focus-within:opacity-100 group-hover:h-7 group-hover:opacity-100',
      className,
    )}
    {...props}>
    {children}
  </div>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

/*
 * Model text can carry words from the pages the agent read, so markdown must not fetch anything by
 * itself: an image whose address holds data would send it out the moment it rendered. No images or
 * embedded media, no raw HTML, and links only to http(s) and mailto, opened by the user's click.
 */
const BLOCKED_ELEMENTS = ['img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed'];

export function safeUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url.trim()) ? url : '';
}

/** Markdown from the model, sanitised, with links that open in a new tab. */
export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        'size-full break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px]',
        '[&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_strong]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5',
        '[&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-medium',
        className,
      )}
      {...props}
      disallowedElements={BLOCKED_ELEMENTS}
      skipHtml
      urlTransform={safeUrl}
    />
  ),
  (prev, next) => prev.children === next.children,
);
MessageResponse.displayName = 'MessageResponse';
