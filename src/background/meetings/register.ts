// Meeting notes register their panel commands and notification clicks here (see ../registry).
import { z } from 'zod';
import { t } from '@extension/i18n';
import { meetingStore } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { createLogger } from '../log';
import { registerCommand } from '../registry';
import { services } from '../registry/services';
import { deliverMeetingEvent, onMeetingNotificationClicked } from './alerts';
import { declineCallTab, joinFlowFor } from './autojoin';
import type { MeetingManager } from './manager';

const logger = createLogger('Meetings');

/**
 * The user invoked the extension on a tab (toolbar button or shortcut): a meeting there that runs on
 * captions only starts recording the audio too.
 *
 * @returns true when it now records the tab's audio
 */
export async function addAudioOnInvoke(meetings: MeetingManager, tabId: number): Promise<boolean> {
  try {
    const meetingId = await meetings.addAudio(tabId);
    if (!meetingId) return false;
    const meeting = await meetingStore.get(meetingId);
    await deliverMeetingEvent({ kind: 'audio_added', meetingId, platform: meeting?.platform ?? '' });
    return true;
  } catch (error) {
    // The captions go on; the user hears that the audio did not
    const meeting = (await meetingStore.active()).find(active => active.tabId === tabId);
    if (meeting) {
      await deliverMeetingEvent({
        kind: 'recorder_failed',
        meetingId: meeting.id,
        platform: meeting.platform,
        reason: toAppError(error).message,
      });
    }
    return false;
  }
}

function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'meeting_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

const meetingId = z.string().min(1).max(100);

// The user's optional note on what the call is about: context for the summary and the notes
command('meeting_add_note', z.object({ meetingId, note: z.string().max(2000) }), async input => {
  const saved = await joinFlowFor(services().meetings).addNote(input.meetingId, input.note);
  return { saved };
});

// "Don't take notes on this call": stops, and the call is not picked up again
command('meeting_skip_call', z.object({ meetingId }), async input => {
  const meeting = await meetingStore.get(input.meetingId);
  if (meeting?.tabId != null) await declineCallTab(meeting.tabId);
  await services().meetings.stop(input.meetingId);
});

// Records the call's audio, on a tab the user already invoked the extension on
command('meeting_add_audio', z.object({ meetingId }), async input => {
  const meeting = await meetingStore.get(input.meetingId);
  if (meeting?.tabId == null) throw new Error(t('meeting_noTab'));
  if (!(await addAudioOnInvoke(services().meetings, meeting.tabId))) throw new Error(t('meeting_needsInvoke'));
});

chrome.notifications.onClicked.addListener(id => void onMeetingNotificationClicked(id));
