import type { MeetingRecord, MeetingWarning, UpcomingEvent } from '@extension/storage';

/**
 * What happens when the user joins a call, as a small state machine with its effects passed in:
 *
 *   joined ──start──▶ recording ──(user adds a note)──▶ recording, with the note as context
 *      │                  │
 *      │                  └─(nothing caught in time: captions off, no audio, no words)──▶ alert
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
  | { kind: 'nothing_captured'; meetingId: string; platform: string; reason: NothingReason }
  | { kind: 'recorder_failed'; meetingId: string; platform: string; reason: string }
  | { kind: 'audio_added'; meetingId: string; platform: string }
  | { kind: 'note_saved'; meetingId: string }
  // The tab's audio stopped mid-call; notes go on from the captions
  | { kind: 'audio_lost'; meetingId: string; platform: string }
  // The note could not be written at the end; Retry tries again
  | { kind: 'note_failed'; meetingId: string; platform: string; reason: string }
  // The note was written after all (a retry worked): an earlier failure alert is done
  | { kind: 'note_written'; meetingId: string };

/**
 * Why nothing has been taken down: the captions are off (and could not be turned on), the captions are
 * on but none arrived for long, no audio has been recorded at all, or the audio is recorded but cannot
 * be written down.
 */
export type NothingReason = 'captions_off' | 'no_captions' | 'no_audio' | 'transcription';

export interface JoinFlowDeps {
  // Starts notes on the tab, recording its audio or else reading its captions; throws when neither works
  start: (tabId: number) => Promise<string>;
  meeting: (meetingId: string) => Promise<MeetingRecord | undefined>;
  segmentCount: (meetingId: string) => Promise<number>;
  // The meeting's recorded audio chunks, and how many of them failed or wait for a retry
  chunkStats: (meetingId: string) => Promise<{ total: number; troubled: number }>;
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
   * Checks that a recording meeting is taking something down, and says so once when it is not:
   *
   * - captions only, not confirmed on (off, or no captions button found): after `graceSeconds`
   * - captions on but none arrived: after twice that (at least 2 minutes), as nobody may have spoken yet
   * - audio, no chunk recorded at all: after `graceSeconds`
   * - audio recorded but every attempt to write it down failed so far: after `graceSeconds`
   *
   * Audio that is recorded and simply quiet is not an alarm: the silence warning covers that.
   *
   * @returns true when it raised the alert
   */
  async checkCapturing(meetingId: string, graceSeconds: number): Promise<boolean> {
    const meeting = await this.deps.meeting(meetingId);
    if (!meeting || meeting.status !== 'recording') return false;
    if (meeting.warnings.includes('nothing_captured')) return false;
    const elapsed = (this.deps.now?.() ?? Date.now()) - meeting.startedAt;
    if (elapsed < graceSeconds * 1000) return false;
    if ((await this.deps.segmentCount(meetingId)) > 0) return false;

    let reason: NothingReason | null = null;
    if (meeting.source === 'captions') {
      if (meeting.captionsOn !== true) reason = 'captions_off';
      else if (elapsed >= Math.max(120, graceSeconds * 2) * 1000) reason = 'no_captions';
    } else {
      const chunks = await this.deps.chunkStats(meetingId);
      if (chunks.total === 0) reason = 'no_audio';
      else if (chunks.troubled > 0) reason = 'transcription';
    }
    if (!reason) return false;
    await this.deps.addWarning(meetingId, 'nothing_captured');
    await this.emit({ kind: 'nothing_captured', meetingId, platform: meeting.platform, reason });
    return true;
  }

  /** The recorder in the offscreen document failed while recording. */
  async recorderFailed(meetingId: string, reason: string): Promise<void> {
    const meeting = await this.deps.meeting(meetingId);
    if (!meeting || meeting.status !== 'recording') return;
    await this.emit({ kind: 'recorder_failed', meetingId, platform: meeting.platform, reason });
  }
}
