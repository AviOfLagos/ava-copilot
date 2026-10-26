import { CALENDAR_ROUTES, calendarEventsRequestSchema } from '@protocol';
import { fail } from '../errors';
import { json } from '../http/server';
import type { Route } from '../http/server';
import type { MacCalendarReader } from './macos';

/** The Mac's Calendar, read-only: every route needs the paired extension (auth 'api'). */
export function calendarRoutes(deps: { calendar: MacCalendarReader }): Route[] {
  const { calendar } = deps;
  const status = (read: Awaited<ReturnType<MacCalendarReader['status']>>) =>
    json({ ok: true, access: read.access, calendars: read.calendars, message: read.message, lost: read.lost === true });
  return [
    {
      method: 'POST',
      path: CALENDAR_ROUTES.status,
      name: 'calendar.status',
      auth: 'api',
      rate: 'read',
      async handler() {
        return status(await calendar.status());
      },
    },
    {
      method: 'POST',
      path: CALENDAR_ROUTES.request,
      name: 'calendar.request',
      auth: 'api',
      rate: 'run',
      async handler() {
        return status(await calendar.request());
      },
    },
    {
      method: 'POST',
      path: CALENDAR_ROUTES.events,
      name: 'calendar.events',
      auth: 'api',
      rate: 'read',
      async handler({ body }) {
        const parsed = calendarEventsRequestSchema.safeParse(body);
        if (!parsed.success) fail('invalid', 'The calendar request is not valid (a window of up to 32 days).');
        const read = await calendar.events(parsed.data.from, parsed.data.to, parsed.data.calendarIds);
        return json({ ok: true, events: read.events, truncated: read.truncated });
      },
    },
  ];
}
