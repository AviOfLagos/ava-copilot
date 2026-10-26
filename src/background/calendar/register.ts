// The Mac's Calendar through Ava Brain, for Settings › Connections › Calendar: whether macOS lets Ava Brain read
// it, the calendars it has, and the one-time permission prompt. The watcher (./watcher.ts) reads the events.
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { calendarSettingsStore } from '@extension/storage';
import { companionClient } from '../companion/client';
import { brainSettingsStore } from '../companion/state';
import { createLogger } from '../log';
import { answerOneOff, registerCommand } from '../registry';
import { services } from '../registry/services';

const logger = createLogger('CalendarMac');

function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'calendar_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message, kind: appError.kind });
    }
  });
}

/** Reads the calendar again after a change, so the panel's list follows at once. */
async function reread(): Promise<string | null> {
  return services()
    .calendar.refresh()
    .catch(error => toAppError(error).message);
}

command('calendar_mac_status', z.object({}), async () => {
  if (!(await brainSettingsStore.getSettings()).paired) return { paired: false };
  const status = await companionClient.calendarStatus({ bypassBreaker: true });
  return {
    paired: true,
    access: status.access,
    calendars: status.calendars,
    message: status.message,
    lost: status.lost,
  };
});

command('calendar_mac_request', z.object({}), async () => {
  const status = await companionClient.calendarRequestAccess();
  if (status.access === 'granted') await reread();
  return {
    paired: true,
    access: status.access,
    calendars: status.calendars,
    message: status.message,
    lost: status.lost,
  };
});

command(
  'calendar_mac_settings',
  z.object({
    macEnabled: z.boolean().optional(),
    macCalendarIds: z.array(z.string().min(1).max(200)).max(300).nullable().optional(),
  }),
  async changes => {
    const next: Parameters<typeof calendarSettingsStore.updateSettings>[0] = {};
    if (changes.macEnabled !== undefined) next.macEnabled = changes.macEnabled;
    if (changes.macCalendarIds !== undefined) next.macCalendarIds = changes.macCalendarIds;
    await calendarSettingsStore.updateSettings(next);
    const error = await reread();
    return { error };
  },
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('calendar_mac_')) return;
  return answerOneOff(message, sendResponse);
});
