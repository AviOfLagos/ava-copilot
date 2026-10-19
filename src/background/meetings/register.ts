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

// Records the call's audio, on a tab the user already invoked the extension on. Chrome hands the audio
// over only after a click on the toolbar icon (or the shortcut) on that tab, which a button in the panel
// cannot stand in for: the call tab comes to the front so that click is one move away.
command('meeting_add_audio', z.object({ meetingId }), async input => {
  const meeting = await meetingStore.get(input.meetingId);
  if (meeting?.tabId == null) throw new Error(t('meeting_noTab'));
  if (await addAudioOnInvoke(services().meetings, meeting.tabId)) return;
  const tab = await chrome.tabs.update(meeting.tabId, { active: true }).catch(() => undefined);
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  throw new Error(t('meeting_needsInvokeAudio'));
});

chrome.notifications.onClicked.addListener(id => void onMeetingNotificationClicked(id));

// The call page saw the user leave: notes end now, not at the next check
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'meeting_call_left' || typeof message.meetingId !== 'string') return;
  if (sender.id !== chrome.runtime.id) return;
  void services()
    .meetings.onCallLeft(message.meetingId, sender.tab?.id)
    .catch(error => logger.warning('Could not end notes after the call', error));
});
