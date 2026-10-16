import { t } from '@extension/i18n';
import { meetingStore } from '@extension/storage';
import { createLogger } from '../log';
import { services } from '../registry/services';
import { addInboxItem, inboxItemId, markDone } from '../inbox/store';
import type { MeetingEvent } from './join-flow';

const logger = createLogger('MeetingAlerts');

export const NOTIFICATION_PREFIX = 'meeting:';
const INBOX_SOURCE = 'meetings';

const notify = (id: string, title: string, message: string, loud: boolean) =>
  chrome.notifications
    .create(`${NOTIFICATION_PREFIX}${id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title,
      message: message.slice(0, 400),
      // A failure stays on screen until the user sees it
      priority: loud ? 2 : 1,
      requireInteraction: loud,
    })
    .catch(error => logger.warning('Could not show the notification', error));

/** Ava says it when a conversation is on; otherwise the notification and the Inbox carry it. */
async function speak(line: string): Promise<void> {
  try {
    await services().voice.announce(line);
  } catch (error) {
    logger.warning('Could not tell the voice conversation', error);
  }
}

async function loud(id: string, title: string, body: string, spoken: string): Promise<void> {
  await notify(id, title, body, true);
  await addInboxItem({
    source: INBOX_SOURCE,
    externalId: id,
    kind: 'alert',
    title,
    body,
    priority: 'normal',
  }).catch(error => logger.warning('Could not add the Inbox alert', error));
  await speak(spoken);
}

/**
 * What the user is told about a meeting, and where: a desktop notification, an Inbox item, and Ava
 * when a voice conversation is on. Failures are loud (the notification stays until dismissed); the
 * "notes started" line is quiet, and its Inbox item is done once the user adds a note.
 */
export async function deliverMeetingEvent(event: MeetingEvent): Promise<void> {
  const platform = event.kind === 'note_saved' ? '' : event.platform || t('meeting_untitled');
  switch (event.kind) {
    case 'started': {
      const lines = [
        event.source === 'audio' ? t('meeting_auto_notifyAudio') : t('meeting_auto_notifyCaptions'),
        ...(event.askNote ? [t('meeting_auto_notifyNote')] : []),
      ];
      await notify(event.meetingId, t('meeting_auto_notifyTitle'), lines.join(' '), false);
      await addInboxItem({
        source: INBOX_SOURCE,
        externalId: `started:${event.meetingId}`,
        kind: 'result',
        title: t('meeting_auto_inboxTitle', [platform]),
        body: `${lines.join(' ')}\n\n${t('meeting_auto_inboxBody')}`,
      }).catch(error => logger.warning('Could not add the Inbox item', error));
      return;
    }
    case 'note_saved':
      await markDone(inboxItemId(INBOX_SOURCE, `started:${event.meetingId}`)).catch(() => {});
      return;
    case 'audio_added':
      await notify(event.meetingId, t('meeting_auto_notifyTitle'), t('meeting_alert_audioAdded'), false);
      return;
    case 'start_failed':
      await loud(
        `failed:${event.tabId}:${Date.now()}`,
        t('meeting_alert_failedTitle'),
        t('meeting_alert_failedBody', [platform, event.reason]),
        `notes could not start on the user's ${platform} call, so it is NOT being recorded. Tell the user now, in one short sentence, and say: ${event.reason}`,
      );
      return;
    case 'nothing_captured':
      await loud(
        `nothing:${event.meetingId}`,
        t('meeting_alert_nothingTitle'),
        t('meeting_alert_nothingBody', [platform]),
        `nothing is being recorded on the user's ${platform} call: no audio and no captions. Tell the user now, in one short sentence, and say to click the Nex Copilot icon on the call to record its audio.`,
      );
      return;
    case 'recorder_failed':
      await loud(
        `recorder:${event.meetingId}`,
        t('meeting_alert_failedTitle'),
        t('meeting_alert_recorderBody', [platform, event.reason]),
        `the recorder stopped working on the user's ${platform} call. Tell the user now, in one short sentence.`,
      );
      return;
  }
}

/** A click on one of these notifications brings the meeting's tab to the front and opens the panel there. */
export async function onMeetingNotificationClicked(notificationId: string): Promise<void> {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
  const id = notificationId.slice(NOTIFICATION_PREFIX.length);
  const tabId = id.startsWith('failed:')
    ? Number(id.split(':')[1])
    : ((await meetingStore.get(id.replace(/^(nothing|recorder):/, '')))?.tabId ?? null);
  await chrome.notifications.clear(notificationId).catch(() => {});
  if (tabId === null || !Number.isFinite(tabId)) return;
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  if (tab?.windowId === undefined) return;
  // The click is the user's gesture: open the panel first, while it still counts
  await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}
