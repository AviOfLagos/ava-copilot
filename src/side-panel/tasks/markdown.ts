import { parseTaskLine } from '@extension/storage';
import type { MarkedLine } from '@extension/storage';

export type TaskSegment = { kind: 'markdown'; text: string } | { kind: 'tasks'; items: MarkedLine[] };

/**
 * A message's Markdown in runs: plain Markdown, and lists of task lines to draw as live checkboxes. A line is a task
 * only when it ends with a marker whose id the message's own `taskIds` vouches for (the code that built the message
 * wrote it). Any other marker, such as one a model wrote into a reply, stays in the Markdown as plain text. Lines in
 * a code block are never tasks.
 */
export function splitTaskLines(markdown: string, taskIds: readonly string[] | undefined): TaskSegment[] {
  const vouched = new Set(taskIds ?? []);
  if (vouched.size === 0) return [{ kind: 'markdown', text: markdown }];
  const segments: TaskSegment[] = [];
  let text: string[] = [];
  let items: MarkedLine[] = [];
  let fenced = false;
  const flushText = () => {
    if (text.some(line => line.trim())) segments.push({ kind: 'markdown', text: text.join('\n') });
    text = [];
  };
  const flushItems = () => {
    if (items.length) segments.push({ kind: 'tasks', items });
    items = [];
  };
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const marked = fenced ? null : parseTaskLine(line);
    if (marked && vouched.has(marked.id)) {
      flushText();
      items.push(marked);
    } else {
      flushItems();
      text.push(line);
    }
  }
  flushText();
  flushItems();
  return segments;
}
