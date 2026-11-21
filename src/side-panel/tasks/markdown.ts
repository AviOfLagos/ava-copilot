import { parseTaskLine, stripTaskMarkers } from '@extension/storage';
import type { MarkedLine } from '@extension/storage';

export type TaskSegment = { kind: 'markdown'; text: string } | { kind: 'tasks'; items: MarkedLine[] };

/**
 * A message's Markdown in runs: plain Markdown, and lists of task lines to draw as live checkboxes. A line is a task
 * only when it ends with a marker whose id the message's own `taskIds` vouches for (the code that built the message
 * wrote it). Any other marker, such as one a model wrote into a reply, is taken out, and a box it was on becomes a
 * plain bullet. Lines in a code block are never tasks and are left as they are.
 */
export function splitTaskLines(markdown: string, taskIds: readonly string[] | undefined): TaskSegment[] {
  const vouched = new Set(taskIds ?? []);
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
      // A box nobody vouched for is a plain bullet: no box that looks tickable and is not
      text.push(fenced ? line : marked ? `${marked.indent}- ${marked.text}` : stripTaskMarkers(line));
    }
  }
  flushText();
  flushItems();
  return segments;
}

/** A message's Markdown with every task marker outside code blocks taken out: for a message that vouches for none. */
export function hideTaskMarkers(markdown: string): string {
  if (!markdown.includes('^tsk_')) return markdown;
  return splitTaskLines(markdown, [])
    .map(segment => (segment.kind === 'markdown' ? segment.text : ''))
    .join('\n');
}
