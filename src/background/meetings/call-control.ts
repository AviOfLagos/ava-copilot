import { meetingStore } from '@extension/storage';
import type { MeetingNote, MeetingRecord } from '@extension/storage';
import { inCall } from './autojoin';
import type { MeetingManager } from './manager';

export type CallMode = 'leave' | 'end';
export type CallResult = 'left' | 'ended' | 'not-host' | 'not-found';

/**
 * Runs in a Google Meet page: leaves the call, or ends it for everyone. Ending never falls back to
 * leaving, and leaving never ends it for others: when the asked-for button is missing, nothing is
 * clicked. Self-contained, as every function sent to a page must be.
 */
export const meetHangUp = async (mode: 'leave' | 'end'): Promise<string> => {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const label = (element: Element) =>
    `${element.getAttribute('aria-label') || ''} ${(element as HTMLElement).innerText || ''}`.trim();
  const find = (pattern: RegExp, scope: ParentNode = document) =>
    (Array.from(scope.querySelectorAll('button, [role="button"], [role="menuitem"], li[role]')) as HTMLElement[]).find(
      element => pattern.test(label(element)) && !/cancel/i.test(label(element)),
    );
  const forEveryone = /end (the )?call for everyone/i;

  if (mode === 'leave') {
    const leave = find(/^leave call|leave call$/i) ?? find(/leave (call|meeting)/i);
    if (!leave) return 'not-found';
    leave.click();
    // A host may be asked whether to just leave or end it for all: always just leave
    for (let i = 0; i < 10; i++) {
      await wait(200);
      const justLeave = find(/just leave/i);
      if (justLeave) {
        justLeave.click();
        break;
      }
    }
    return 'left';
  }

  let end = find(forEveryone);
  if (!end) {
    const options = find(/(end|leave)[- ]call options|more options for (ending|leaving)|options for ending/i);
    if (!options) return 'not-host';
    options.click();
    for (let i = 0; i < 10 && !end; i++) {
      await wait(200);
      end = find(forEveryone);
    }
    if (!end) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'not-host';
    }
  }
  end.click();
  // Meet asks once more; its confirm button carries the same words or a plain "End call"
  for (let i = 0; i < 10; i++) {
    await wait(200);
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
    const confirm = dialog ? find(/end (the )?call/i, dialog) : undefined;
    if (confirm) {
      confirm.click();
      break;
    }
  }
  return 'ended';
};

/** Runs in a Google Meet page before the call: presses "Join now" or "Ask to join". */
export const meetJoin = (): boolean => {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
  const join = buttons.find(button => /^(join now|ask to join)$/i.test((button.innerText || '').trim()));
  join?.click();
  return !!join;
};

// A plain yes, said right after the copilot asked
const AFFIRM =
  /^\W*(yes|yeah|yep|yup|sure|correct|do it|go ahead|please do|ok(ay)?)(\W+(please|do it|go ahead|for everyone))*\W*$/i;
const NEGATED = /\b(don'?t|do not|never|not|no need to|stop)\b[^.?!]{0,15}\b(end|close|leave|join|hang)/i;

/** One order in the user's words: the turn itself, or a plain yes to the turn before it. */
function ordered(order: RegExp, heard: string, before = ''): boolean {
  const said = (text: string) => order.test(text) && !NEGATED.test(text);
  return said(heard) || (AFFIRM.test(heard) && said(before));
}

const END =
  /\b(end|close|finish|terminate|kill|shut down)\b(?! of\b)\s+(the |this |our |my )?(call|meeting)\b|\bend (it|this|the call|the meeting) for (everyone|everybody|all)\b/i;
const LEAVE = /\b(leave|exit|drop( off)?( from)?|hang up|get (me )?out of)\b\s*(the |this |my )?(call|meeting)?\b/i;
const JOIN = /\b(join|enter|get (me )?(in|into)|let me in)\b/i;

/**
 * Whether the user's own words asked to end the call for everyone, not just to leave it.
 * Only this turn counts, or a plain yes to the one before: never words from longer ago.
 */
export function spokeEnd(heard: string, before = ''): boolean {
  return ordered(END, heard, before);
}

/** Whether the user's own words asked to leave the call, or to end it. */
export function spokeLeave(heard: string, before = ''): boolean {
  return ordered(LEAVE, heard, before) || spokeEnd(heard, before);
}

/** Whether the user's own words asked to join a meeting, not just to open it. */
export function spokeJoin(heard: string, before = ''): boolean {
  return ordered(JOIN, heard, before);
}

function isMeet(url = ''): boolean {
  try {
    return new URL(url).hostname === 'meet.google.com';
  } catch {
    return false;
  }
}

/** The Meet tab the user is in a call on: the one being recorded first, else any in a call. */
async function callTab(recording: MeetingRecord | undefined): Promise<number | null> {
  if (recording?.tabId != null) {
    const tab = await chrome.tabs.get(recording.tabId).catch(() => undefined);
    if (tab?.id !== undefined && isMeet(tab.url)) return tab.id;
  }
  for (const tab of await chrome.tabs.query({ url: 'https://meet.google.com/*' })) {
    if (tab.id === undefined) continue;
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inCall }).catch(() => []);
    if (result?.result === true) return tab.id;
  }
  return null;
}

/**
 * Leaves the Google Meet call, or ends it for everyone, then stops its notes. When the call has already
 * closed, the notes still stop, so the summary comes either way.
 *
 * @returns What happened to the call, and the meeting whose notes were stopped
 */
export async function hangUp(
  meetings: MeetingManager,
  mode: CallMode,
): Promise<{ result: CallResult; meetingId: string | null }> {
  const recording = (await meetingStore.active()).find(meeting => meeting.status === 'recording');
  const tabId = await callTab(recording);
  let result: CallResult = 'not-found';
  if (tabId !== null) {
    const [ran] = await chrome.scripting
      .executeScript({ target: { tabId }, func: meetHangUp, args: [mode] })
      .catch(() => []);
    result = (ran?.result as CallResult | undefined) ?? 'not-found';
  }
  // Not the host: the call goes on, and so do the notes
  if (result === 'not-host') return { result, meetingId: null };
  if (recording) await meetings.stop(recording.id);
  return { result, meetingId: recording?.id ?? null };
}

/** Waits for a meeting's note, as long as the summary takes, up to a limit. */
export async function waitForNote(meetingId: string, ms = 90_000): Promise<MeetingRecord | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const meeting = await meetingStore.get(meetingId);
    if (!meeting || meeting.status === 'failed') return meeting ?? null;
    if (meeting.status === 'done') return meeting;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return null;
}

/** A note as the copilot reads it out: the gist, decisions and who does what. */
export function describeNote(note: MeetingNote): string {
  const lines = [`Summary of "${note.title}":`, ...note.tldr.map(line => `- ${line}`)];
  if (note.decisions.length) lines.push('Decisions:', ...note.decisions.map(line => `- ${line}`));
  if (note.actionItems.length) {
    lines.push(
      'Action points:',
      ...note.actionItems.map(item => `- ${item.task}${item.owner ? ` (${item.owner})` : ''}`),
    );
  }
  return lines.join('\n');
}
