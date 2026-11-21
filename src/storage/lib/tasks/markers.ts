import type { Task } from './types';

// The task marker (docs/pm-desk.md, Part 2.3): a task written into Markdown ends with "^tsk_…", which the panel's
// renderer draws as a live checkbox when the code that built the message vouches for it. Everywhere else
// (WhatsApp, voice, exports, a model's prompt) the marker is taken out.

const MARKER = /[ \t]*\^(tsk_[a-z2-7]{10})(?![a-z0-9_])/g;

/** " ^tsk_…": what goes at the end of a task's line. */
export const taskMarker = (id: string): string => ` ^${id}`;

/** The text with every task marker taken out. */
export function stripTaskMarkers(text: string): string {
  return text.replace(MARKER, '');
}

/** A task's line as code writes it: its box, its title (already plain), its marker. */
export function taskLine(task: Pick<Task, 'id' | 'status'>, text: string): string {
  return `- [${task.status === 'open' ? ' ' : 'x'}] ${text}${taskMarker(task.id)}`;
}

export interface MarkedLine {
  // The line's text without its box and marker
  text: string;
  id: string;
  checked: boolean;
  indent: string;
}

const LINE = /^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]+(.*?)[ \t]+\^(tsk_[a-z2-7]{10})[ \t]*$/;

/** A Markdown list line with a box and a task marker at its end, or null. */
export function parseTaskLine(line: string): MarkedLine | null {
  const match = LINE.exec(line);
  if (!match) return null;
  return { indent: match[1], checked: match[2] !== ' ', text: match[3], id: match[4] };
}
