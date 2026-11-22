// Tasks Avi says on a call (docs/pm-desk.md, Part 6), kept on the meeting record as a plain field: no index, so no
// Dexie version step. The tasks themselves live on the task board; this only says which came from this call, how
// each was heard, and what Avi did about them.

// Whose speech counted on this call: the page's own-line marker on captions, a separate echo-cancelled
// microphone stream written down on this computer, or nothing (spoken commands are off and the panel says so)
export type CallCommandSignal = 'captions' | 'mic' | 'off';

// Why spoken commands are off, for the panel's one line
export type CallCommandOffReason =
  | 'no_captions_no_mic'
  | 'no_local_recogniser'
  | 'mic_denied'
  | 'mic_off'
  // Meet showed the user's own line ("You") without the page's own-line mark, so it cannot be told apart
  | 'no_self_marker';

export interface CallTaskEntry {
  taskId: string;
  // The name as said, after vocabulary correction; null for "a task for me"
  ownerName: string | null;
  // The sentence that made it, at most 300 chars (never shown to a model as instructions)
  said: string;
  // Sentences added to it ("also…")
  added: string[];
  // Which signal heard it
  signal: Exclude<CallCommandSignal, 'off'>;
  // Where it was heard: the caption block's key on the page, or 'mic'
  heardIn: string;
  at: number;
  // The panel's "Record the screen for this?": unanswered, answered No, or Yes (a recording was started)
  recordOffer?: 'no' | 'yes';
}

// A row another part adds to the after-call list, such as "Mark done?" from the follow-ups part (#111). The
// background writes it; the panel draws `text` and, when there is one, a button labelled `action.label`. The button
// sends only the meeting and the row's id: the background finds the row and runs what that part registered for its
// `kind` (`onCallListRowAction`), so nothing the panel sends chooses what runs
export interface CallListRow {
  id: string;
  kind: string;
  // The person it goes under: a Person id, or the name as said in lower case
  personKey: string | null;
  personName: string;
  text: string;
  taskId?: string;
  action?: { label: string };
}

// What "Looks right" did for one person
export interface CallTaskSent {
  personKey: string;
  name: string;
  taskIds: string[];
  // What the WhatsApp part said: sent, queued (quiet hours), off, empty, done (already sent)
  whatsapp: 'sent' | 'queued' | 'off' | 'empty' | 'done' | 'failed';
  links: string[];
}

export interface CallTasksState {
  signal: CallCommandSignal;
  offReason?: CallCommandOffReason;
  // The page marked a caption line as the user's own at least once: the mark works on this call
  selfLineSeen?: boolean;
  // A line labelled as the user's ("You") came without the mark (before any marked line): captions cannot tell
  selfMarkerMissing?: boolean;
  // A line marked as the user's carried another speaker's name: the mark is unreliable on this call
  selfMarkerOnOthers?: boolean;
  // The microphone stream for commands could not start: denied, or failed
  micFailed?: 'denied' | 'failed';
  tasks: CallTaskEntry[];
  // The task still open for "also…": until `closeAt` (four seconds after another sentence) or `until` (two minutes)
  open?: { taskId: string; until: number; closeAt: number | null } | null;
  // A command heard with no words yet ("Ava, note a task for Ada."): the next sentence is its words
  pending?: {
    ownerName: string | null;
    said: string;
    heardIn: string;
    signal: 'captions' | 'mic';
    until: number;
  } | null;
  rows?: CallListRow[];
  // "Looks right": nothing was sent or shared before this
  confirmedAt?: number;
  sent?: CallTaskSent[];
  // Recording links that could not be shared, in words
  shareSkipped?: string[];
}

/**
 * Who a call's task goes under on the after-call list and in its messages: the person, when known; else the name
 * as said; else Avi himself ('me', "a task for me"). The panel and the background use this one rule.
 */
export const callPersonKey = (task: { ownerId: string | null; ownerName: string | null }): string =>
  task.ownerId ?? (task.ownerName ? `name:${task.ownerName.trim().toLowerCase()}` : 'me');
