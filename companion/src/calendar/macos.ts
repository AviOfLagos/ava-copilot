import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALENDAR_LIMITS, meetingLinkIn } from '@protocol';
import type { CalendarAccess, MacCalendar, MacEvent } from '@protocol';
import { AppError, fail } from '../errors';
import type { Logger } from '../log';
import { hostToolEnv } from '../sandbox/process';
import type { ProcessRunner } from '../sandbox/process';

/**
 * The Mac's Calendar, read through EventKit from JavaScript for Automation (`osascript -l JavaScript`), run
 * without a shell by the process runner. macOS Calendar syncs every account under System Settings › Internet
 * Accounts (Google and Workspace included), so this reads calendars the browser cannot. Read-only.
 *
 * macOS asks once whether the process may read calendars, and ties the answer to the program responsible for
 * Ava Brain. Installed by scripts/install-launchagent.sh that is "Ava Brain" (Ava Brain.app runs node as its
 * child and sets AVA_BRAIN_PROGRAM); on an older install it is `node` itself, and every Node upgrade makes macOS
 * forget the answer. Either way, that name is what macOS shows in the prompt and in System Settings › Privacy &
 * Security › Calendars, so the steps below use it.
 */

export const OSASCRIPT = '/usr/bin/osascript';
const STATUS_TIMEOUT_MS = 30_000;
// The prompt waits for the user's click
const REQUEST_TIMEOUT_MS = 120_000;
// A read that times out (Calendar is slow after a restart or a wake) answers with the last good one this recent
const LAST_GOOD_MS = 30 * 60_000;

// Runs in osascript: plain ES5-ish JavaScript with the ObjC bridge. argv: mode, from ms, to ms, calendar ids JSON
export const EVENTKIT_SCRIPT = `
ObjC.import('EventKit');
ObjC.import('Foundation');
function run(argv) {
  var mode = argv[0] || 'status';
  var ET = 0;
  var authStatus = function () { return Number($.EKEventStore.authorizationStatusForEntityType(ET)); };
  var status = authStatus();
  var store = $.EKEventStore.alloc.init;
  if (mode === 'request' && status === 0) {
    var done = false;
    var callback = function (granted, error) { done = true; };
    try {
      if (store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) {
        store.requestFullAccessToEventsWithCompletion(callback);
      } else {
        store.requestAccessToEntityTypeCompletion(ET, callback);
      }
      var until = Date.now() + 100000;
      while (!done && Date.now() < until) {
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.25));
      }
    } catch (error) {}
    status = authStatus();
    store = $.EKEventStore.alloc.init;
  }
  var out = { status: status, calendars: [], events: [], truncated: false };
  if (status !== 3) return JSON.stringify(out);
  var text = function (value) { var plain = ObjC.unwrap(value); return typeof plain === 'string' ? plain : ''; };
  var wanted = mode === 'events' && argv[3] ? JSON.parse(argv[3]) : null;
  var calendars = store.calendarsForEntityType(ET);
  var chosen = $.NSMutableArray.array;
  for (var i = 0; i < calendars.count && i < ${CALENDAR_LIMITS.calendars}; i++) {
    var calendar = calendars.objectAtIndex(i);
    var id = text(calendar.calendarIdentifier);
    out.calendars.push({ id: id, title: text(calendar.title), account: text(calendar.source.title) });
    if (!wanted || wanted.indexOf(id) >= 0) chosen.addObject(calendar);
  }
  if (mode !== 'events' || chosen.count === 0) return JSON.stringify(out);
  var from = $.NSDate.dateWithTimeIntervalSince1970(Number(argv[1]) / 1000);
  var to = $.NSDate.dateWithTimeIntervalSince1970(Number(argv[2]) / 1000);
  var events = store.eventsMatchingPredicate(store.predicateForEventsWithStartDateEndDateCalendars(from, to, chosen));
  for (var j = 0; j < events.count; j++) {
    if (out.events.length >= ${CALENDAR_LIMITS.events}) { out.truncated = true; break; }
    var event = events.objectAtIndex(j);
    if (Number(event.status) === 3) continue;
    var start = Math.round(Number(event.startDate.timeIntervalSince1970) * 1000);
    out.events.push({
      id: (text(event.eventIdentifier) || text(event.calendarItemIdentifier)) + '@' + start,
      calendarId: text(event.calendar.calendarIdentifier),
      calendar: text(event.calendar.title),
      title: text(event.title),
      start: start,
      end: Math.round(Number(event.endDate.timeIntervalSince1970) * 1000),
      allDay: event.allDay === true || Number(event.allDay) === 1,
      location: text(event.location),
      notes: text(event.notes).slice(0, ${CALENDAR_LIMITS.notesChars}),
      url: text(event.URL.absoluteString) || null
    });
  }
  return JSON.stringify(out);
}
`;

// EKAuthorizationStatus: 0 not determined, 1 restricted, 2 denied, 3 full access (authorized), 4 write only
const ACCESS_OF_STATUS: Record<number, CalendarAccess> = {
  0: 'not_determined',
  1: 'restricted',
  2: 'denied',
  3: 'granted',
  4: 'write_only',
};

/** The name macOS gives Ava Brain in its prompts: "Ava Brain" under Ava Brain.app, otherwise "node". */
export function programName(env: NodeJS.ProcessEnv = process.env): string {
  const name = (env.AVA_BRAIN_PROGRAM ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim();
  return name.slice(0, 40) || 'node';
}

/** What to do for each state, naming the program macOS asks about. Exported for tests. */
export function calendarMessages(program: string): Record<CalendarAccess, string | null> {
  return {
    granted: null,
    not_determined:
      'Ava Brain needs your permission to read the Mac’s Calendar. In Ava Copilot press “Allow access” and choose ' +
      `Allow in the macOS prompt (it names “${program}”, the program Ava Brain runs as). If no prompt shows, open ` +
      `System Settings › Privacy & Security › Calendars and turn on “${program}” with Full Access, then press Check again.`,
    denied:
      'macOS does not let Ava Brain read your calendars. Open System Settings › Privacy & Security › Calendars, turn on ' +
      `“${program}” with Full Access, then press Check again.`,
    restricted:
      'Calendar access is restricted on this Mac (by Screen Time or a device profile), so Ava Brain cannot read it.',
    write_only:
      'Ava Brain may only add events, not read them. Open System Settings › Privacy & Security › Calendars and change ' +
      `“${program}” to Full Access, then press Check again.`,
    unavailable: 'The Mac’s Calendar cannot be read here (this needs macOS with osascript).',
  };
}

/**
 * Said instead when Ava Brain could read the Calendar before and now cannot: almost always because the program
 * it runs as changed (a Node upgrade on an older install, or a new Ava Brain.app), which makes macOS ask again.
 */
export function lostMessage(program: string, access: CalendarAccess): string {
  const why =
    'Ava Brain could read your Calendar before, but macOS took the permission back. macOS asks again whenever the ' +
    `program Ava Brain runs as changes${program === 'node' ? ' (here “node”, so after every Node upgrade)' : ''}.`;
  if (access === 'not_determined') {
    return (
      `${why} Press “Allow access” (or “Allow on the Mac”) and choose Allow in the macOS prompt (it names ` +
      `“${program}”). If no prompt shows, turn on “${program}” in System Settings › Privacy & Security › Calendars.`
    );
  }
  return `${why} Open System Settings › Privacy & Security › Calendars, turn on “${program}” with Full Access, then press Check again.`;
}

export const CALENDAR_STEPS = calendarMessages('node').not_determined as string;

export interface CalendarRead {
  access: CalendarAccess;
  calendars: MacCalendar[];
  events: MacEvent[];
  truncated: boolean;
  message: string | null;
  // Access was granted before and is gone now (see lostMessage)
  lost?: boolean;
}

const clip = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

/** osascript's JSON, checked and capped; anything else is an error. Exported for tests. */
export function parseCalendarOutput(stdout: string, program = 'node'): CalendarRead {
  let raw: { status?: unknown; calendars?: unknown; events?: unknown; truncated?: unknown };
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    fail('unavailable', 'The Mac’s Calendar answered something Ava Brain could not read.');
  }
  const access = ACCESS_OF_STATUS[Number(raw.status)] ?? 'unavailable';
  const calendars: MacCalendar[] = (Array.isArray(raw.calendars) ? raw.calendars : [])
    .slice(0, CALENDAR_LIMITS.calendars)
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(item => ({
      id: clip(item.id, 200),
      title: clip(item.title, 200) || 'Calendar',
      account: clip(item.account, 200),
      color: null,
    }))
    .filter(item => item.id);
  const events: MacEvent[] = [];
  for (const item of Array.isArray(raw.events) ? raw.events : []) {
    if (events.length >= CALENDAR_LIMITS.events) break;
    if (typeof item !== 'object' || item === null) continue;
    const event = item as Record<string, unknown>;
    const start = Number(event.start);
    const end = Number(event.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const location = clip(event.location, 1000);
    const notes = clip(event.notes, CALENDAR_LIMITS.notesChars);
    const url = clip(event.url, 2000) || null;
    events.push({
      id: clip(event.id, 400) || `event@${start}`,
      calendarId: clip(event.calendarId, 200),
      calendar: clip(event.calendar, 200),
      title: clip(event.title, 500) || 'Untitled event',
      start,
      end: end > start ? end : start + 30 * 60_000,
      allDay: event.allDay === true,
      location,
      notes,
      url,
      joinUrl: meetingLinkIn(`${location} ${url ?? ''} ${notes}`),
    });
  }
  events.sort((a, b) => a.start - b.start);
  return { access, calendars, events, truncated: raw.truncated === true, message: calendarMessages(program)[access] };
}

/**
 * Remembers, in the data folder, that Calendar access was granted once, so a later "not determined" or "denied"
 * (even after a restart) reads as permission lost rather than never given.
 */
export class CalendarAccessMemory {
  private granted: boolean | null = null;

  constructor(private readonly path: string | null) {}

  wasGranted(): boolean {
    if (this.granted === null) {
      try {
        this.granted =
          !!this.path && existsSync(this.path) && JSON.parse(readFileSync(this.path, 'utf8')).granted === true;
      } catch {
        this.granted = false;
      }
    }
    return this.granted;
  }

  rememberGranted(at: number): void {
    if (this.wasGranted()) return;
    this.granted = true;
    if (!this.path) return;
    try {
      writeFileSync(this.path, JSON.stringify({ granted: true, at }), { mode: 0o600 });
    } catch {
      // Only the wording of a later message depends on it
    }
  }
}

export class MacCalendarReader {
  private lastGood: { key: string; at: number; read: CalendarRead } | null = null;

  private readonly program: string;
  private readonly messages: Record<CalendarAccess, string | null>;
  private readonly memory: CalendarAccessMemory;

  constructor(
    private readonly deps: {
      run: ProcessRunner;
      log: Logger;
      platform?: NodeJS.Platform;
      now?: () => number;
      // Where "access was granted once" is kept across restarts; in memory only without it
      dataDir?: string;
      env?: NodeJS.ProcessEnv;
    },
  ) {
    this.program = programName(deps.env);
    this.messages = calendarMessages(this.program);
    this.memory = new CalendarAccessMemory(deps.dataDir ? join(deps.dataDir, 'calendar-access.json') : null);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Asks Calendar once in the background, so the first real read is not the slow cold one. */
  warmUp(): void {
    void this.status().catch(() => {});
  }

  /** Notes a granted read, and words a missing permission as lost when it was granted before. */
  private async script(args: string[], timeoutMs: number): Promise<CalendarRead> {
    const read = await this.runScript(args, timeoutMs);
    if (read.access === 'granted') {
      this.memory.rememberGranted(this.now());
      return read;
    }
    if ((read.access === 'not_determined' || read.access === 'denied') && this.memory.wasGranted()) {
      this.deps.log.warn('Calendar permission was lost', { access: read.access, program: this.program });
      return { ...read, lost: true, message: lostMessage(this.program, read.access) };
    }
    return read;
  }

  private async runScript(args: string[], timeoutMs: number): Promise<CalendarRead> {
    if ((this.deps.platform ?? process.platform) !== 'darwin') {
      return { access: 'unavailable', calendars: [], events: [], truncated: false, message: this.messages.unavailable };
    }
    let result;
    try {
      result = await this.deps.run(OSASCRIPT, ['-l', 'JavaScript', '-e', EVENTKIT_SCRIPT, ...args], {
        env: hostToolEnv(),
        timeoutMs,
        maxOutputBytes: 4_000_000,
      });
    } catch (error) {
      this.deps.log.warn('osascript did not start', { error: (error as Error).message });
      return { access: 'unavailable', calendars: [], events: [], truncated: false, message: this.messages.unavailable };
    }
    if (result.timedOut) fail('timeout', 'The Mac’s Calendar took too long to answer. Try again.');
    if (result.code !== 0) {
      // Never the script or the events in the log: only that it failed
      this.deps.log.warn('Reading the Mac’s Calendar failed', { code: result.code });
      if (/not authori[sz]ed|not allowed|denied|-1743|-10004/i.test(result.stderr)) {
        return { access: 'denied', calendars: [], events: [], truncated: false, message: this.messages.denied };
      }
      fail('unavailable', 'The Mac’s Calendar could not be read. Open the Calendar app once, then try again.');
    }
    return parseCalendarOutput(result.stdout, this.program);
  }

  status(): Promise<CalendarRead> {
    return this.script(['status'], STATUS_TIMEOUT_MS);
  }

  /** Shows macOS's one-time Calendars prompt when it was never answered; otherwise only reads the state. */
  request(): Promise<CalendarRead> {
    return this.script(['request'], REQUEST_TIMEOUT_MS);
  }

  async events(from: number, to: number, calendarIds: string[] | null): Promise<CalendarRead> {
    const args = [
      'events',
      String(Math.floor(from)),
      String(Math.floor(to)),
      calendarIds ? JSON.stringify(calendarIds) : '',
    ];
    // The same calendars over the same hours (to the minute) can stand in for each other
    const key = JSON.stringify([Math.floor(from / 60_000), Math.floor(to / 60_000), calendarIds]);
    let read: CalendarRead;
    try {
      read = await this.script(args, STATUS_TIMEOUT_MS);
    } catch (error) {
      const last = this.lastGood;
      if (AppError.isInstance(error) && error.kind === 'timeout' && last && this.now() - last.at < LAST_GOOD_MS) {
        if (last.key === key) return last.read;
      }
      throw error;
    }
    if (read.access !== 'granted') {
      this.lastGood = null;
      fail('forbidden', read.message ?? CALENDAR_STEPS);
    }
    this.lastGood = { key, at: this.now(), read };
    return read;
  }
}
