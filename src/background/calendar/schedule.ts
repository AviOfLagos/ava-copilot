import { wrapUntrustedContent } from '../agent/messages/utils';
import { quoteTitle } from './watcher';
import type { CalendarWatcher } from './watcher';

/**
 * The calendar for the coming hours, one line per event, as the voice tool `get_schedule` and the chat action of
 * the same name both answer it. Titles come from invites anyone could send: they are data, never instructions.
 */
export async function scheduleText(calendar: CalendarWatcher | null, hours?: unknown): Promise<string> {
  if (!calendar) return 'No calendar is connected.';
  const events = await calendar.upcoming(Number(hours) > 0 ? Number(hours) : 24);
  if (events.length === 0) return 'Nothing on the calendar in that time, or no calendar is connected in settings.';
  return wrapUntrustedContent(
    events
      .map(event => {
        const at = new Date(event.start).toLocaleString(undefined, {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        });
        return `${at}: "${quoteTitle(event.title)}"${event.joinUrl ? ' (has a meeting link)' : ''}`;
      })
      .join('\n'),
  );
}
