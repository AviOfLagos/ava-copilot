import type { MeetingRecord, MeetingWarning, UpcomingEvent } from '@extension/storage';

/**
 * What happens when the user joins a call, as a small state machine with its effects passed in:
 *
 *   joined ──start──▶ recording ──(user adds a note)──▶ recording, with the note as context
 *      │                  │
 *      │                  └─(captions only, nothing caught in time)──▶ alert
 *      └─(could not start)──▶ alert
 *
 * Notes start at once; nothing waits on an answer. The note is asked for where the user will see it
 * (the side panel and the Inbox), and ignoring it changes nothing. Every way it can fail is said out
 * loud through `emit`: a desktop notification, an Inbox item, and Ava when a conversation is on.
 */

export type MeetingEvent =
  // Notes are being taken; `askNote` when nothing explains what the call is, so a note is welcome
  | { kind: 'started'; meetingId: string; platform: string; source: MeetingRecord['source']; askNote: boolean }
  | { kind: 'start_failed'; tabId: number; platform: string; reason: string }
  | { kind: 'nothing_captured'; meetingId: string; platform: string }
  | { kind: 'recorder_failed'; meetingId: string; platform: string; reason: string }
  | { kind: 'audio_added'; meetingId: string; platform: string }
  | { kind: 'note_saved'; meetingId: string };

export interface JoinFlowDeps {
  // Starts notes on the tab, recording its audio or else reading its captions; throws when neither works
  start: (tabId: number) => Promise<string>;
  meeting: (meetingId: string) => Promise<MeetingRecord | undefined>;
  segmentCount: (meetingId: string) => Promise<number>;
  setTopic: (meetingId: string, topic: string, source: 'user' | 'calendar') => Promise<void>;
  addWarning: (meetingId: string, warning: MeetingWarning) => Promise<void>;
  // The calendar event this call belongs to, when the calendar says
  calendarEvent: (url: string) => Promise<UpcomingEvent | null>;
  emit: (event: MeetingEvent) => Promise<void>;
  platformOf: (url: string) => string;
  now?: () => number;
}

export type JoinResult = { ok: true; meetingId: string } | { ok: false; reason: string };

export class JoinFlow {
  constructor(private readonly deps: JoinFlowDeps) {}

  private async emit(event: MeetingEvent): Promise<void> {
    // Telling the user must never stop the notes themselves
    await this.deps.emit(event).catch(() => {});
  }

  /** The user is in a call on this tab: notes start now, without asking anything first. */
  async joined(tabId: number, url: string): Promise<JoinResult> {
    const platform = this.deps.platformOf(url);
    let meetingId: string;
    try {
      meetingId = await this.deps.start(tabId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.emit({ kind: 'start_failed', tabId, platform, reason });
      return { ok: false, reason };
    }
    const event = await this.deps.calendarEvent(url).catch(() => null);
    if (event?.title) await this.deps.setTopic(meetingId, event.title, 'calendar').catch(() => {});
    const meeting = await this.deps.meeting(meetingId);
    await this.emit({
      kind: 'started',
      meetingId,
      platform,
      source: meeting?.source ?? 'audio',
      askNote: !event?.title,
    });
    return { ok: true, meetingId };
  }

  /**
   * The user's note on what the call is about: it becomes context for the summary and the notes.
   * An empty note changes nothing.
   */
  async addNote(meetingId: string, note: string): Promise<boolean> {
    const clean = note.replace(/\s+/g, ' ').trim();
    if (!clean) return false;
    const meeting = await this.deps.meeting(meetingId);
    if (!meeting) return false;
    await this.deps.setTopic(meetingId, clean, 'user');
    await this.emit({ kind: 'note_saved', meetingId });
    return true;
  }

  /**
   * Checks a recording meeting that runs on captions only: when none has arrived after
   * `graceSeconds`, nothing is being taken down, and the user hears so once.
   *
   * @returns true when it raised the alert
   */
  async checkCapturing(meetingId: string, graceSeconds: number): Promise<boolean> {
    const meeting = await this.deps.meeting(meetingId);
    if (!meeting || meeting.status !== 'recording' || meeting.source !== 'captions') return false;
    if (meeting.warnings.includes('nothing_captured')) return false;
    const now = this.deps.now?.() ?? Date.now();
    if (now - meeting.startedAt < graceSeconds * 1000) return false;
    if ((await this.deps.segmentCount(meetingId)) > 0) return false;
    await this.deps.addWarning(meetingId, 'nothing_captured');
    await this.emit({ kind: 'nothing_captured', meetingId, platform: meeting.platform });
    return true;
  }

  /** The recorder in the offscreen document failed while recording. */
  async recorderFailed(meetingId: string, reason: string): Promise<void> {
    const meeting = await this.deps.meeting(meetingId);
    if (!meeting || meeting.status !== 'recording') return;
    await this.emit({ kind: 'recorder_failed', meetingId, platform: meeting.platform, reason });
  }
}
