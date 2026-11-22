// Two lines the code writes into the brief (docs/pm-desk.md, Part 3), drawn by the panel as buttons:
//   ^ws_make          the "Make a workspace for these" button under the "No workspace" group
//   ^ws_undo_<id>     "Moved 3 things to Tech Ember Fest" and its Undo
// A line is a button only in a message the code vouches for (`ThreadMessage.workspaceLines`); anywhere else (a model's
// reply, WhatsApp, voice, copy, export, the knowledge base) it is taken out, like a task marker.

export const MAKE_WORKSPACE_LINE = '^ws_make';

// Any whitespace around a line counts, in the parse and the strip alike: a line one of them reads as a button the other
// must take out (a "\r" or a no-break space on a model's line must not leave a button behind)
const MAKE_LINE = /^\s*\^ws_make\s*$/;
const UNDO_LINE = /^\s*\^ws_undo_(wsm_[a-z2-7]{10})\s*$/;
const ANY_LINE = /^\s*\^ws_(?:make|undo_wsm_[a-z2-7]{10})\s*$/;

export const undoMoveLine = (moveId: string): string => `^ws_undo_${moveId}`;

export type WorkspaceLine = { kind: 'make' } | { kind: 'undo'; moveId: string };

/** The button a line stands for, or null when it is ordinary text. */
export function parseWorkspaceLine(line: string): WorkspaceLine | null {
  if (MAKE_LINE.test(line)) return { kind: 'make' };
  const undo = UNDO_LINE.exec(line);
  return undo ? { kind: 'undo', moveId: undo[1] } : null;
}

/** The text with every workspace line taken out. */
export function stripWorkspaceMarkers(text: string): string {
  if (!text.includes('^ws_')) return text;
  return text
    .split('\n')
    .filter(line => !ANY_LINE.test(line))
    .join('\n');
}

export type WorkspaceSegment = { kind: 'markdown'; text: string } | WorkspaceLine;

/** A message's Markdown in runs: plain text and the buttons its workspace lines stand for. Lines in code blocks stay text. */
export function splitWorkspaceLines(markdown: string): WorkspaceSegment[] {
  if (!markdown.includes('^ws_')) return [{ kind: 'markdown', text: markdown }];
  const segments: WorkspaceSegment[] = [];
  let text: string[] = [];
  let fenced = false;
  const flush = () => {
    if (text.some(line => line.trim())) segments.push({ kind: 'markdown', text: text.join('\n') });
    text = [];
  };
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const found = fenced ? null : parseWorkspaceLine(line);
    if (found) {
      flush();
      segments.push(found);
    } else {
      text.push(line);
    }
  }
  flush();
  return segments;
}
