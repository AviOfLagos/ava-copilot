import { t } from '@extension/i18n';
import type { MeetingRecord } from '@extension/storage';

/** Where a recording meeting really stands: words coming in, or still waiting for its captions or audio. */
export type Capture = 'hearing' | 'no_words' | 'waiting_captions' | 'captions_off';

export function captureOf(
  meeting: Pick<MeetingRecord, 'source' | 'captionsOn'> & { warnings?: MeetingRecord['warnings'] },
  words: number,
): Capture {
  if (words > 0) return 'hearing';
  if (meeting.source === 'audio') return 'no_words';
  // Off, or not found and could not be turned on
  const off = meeting.captionsOn === false || (meeting.warnings ?? []).includes('captions_off');
  return off ? 'captions_off' : 'waiting_captions';
}

/**
 * The status line of a recording meeting. "Recording" alone is only said once there is something to show
 * for it; before that it says what it waits for, so a meeting that takes nothing down never looks fine.
 */
export function recordingStatus(
  meeting: Pick<MeetingRecord, 'source' | 'captionsOn'> & { warnings?: MeetingRecord['warnings'] },
  words: number,
  time: string,
): string {
  switch (captureOf(meeting, words)) {
    case 'hearing':
      return t('meeting_status_recording', [time]);
    case 'no_words':
      return t('meeting_status_noWords', [time]);
    case 'captions_off':
      return t('meeting_status_captionsOff', [time]);
    case 'waiting_captions':
      return t('meeting_status_waitingCaptions', [time]);
  }
}
