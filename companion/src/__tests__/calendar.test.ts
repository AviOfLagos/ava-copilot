import { describe, expect, it } from 'vitest';
import { CALENDAR_LIMITS, CALENDAR_ROUTES, meetingLinkIn } from '@protocol';
import { MacCalendarReader, OSASCRIPT, parseCalendarOutput, programName } from '../calendar/macos';
import { memoryLogger } from '../log';
import { dockerUp, fakeRunner, startTestBrain, tempDir } from './helpers';
import type { FakeCall } from './helpers';

// osascript is never run against the real Calendar here: every answer is scripted
const HOUR = 3_600_000;
const granted = (events: unknown[] = []) =>
  JSON.stringify({
    status: 3,
    calendars: [
      { id: 'cal-work', title: 'Work', account: 'avi@nexprove.com' },
      { id: 'cal-home', title: 'Home', account: 'iCloud' },
    ],
    events,
    truncated: false,
  });

const event = (overrides: Record<string, unknown> = {}) => ({
  id: 'E1@1000',
  calendarId: 'cal-work',
  calendar: 'Work',
  title: 'Standup',
  start: 2 * HOUR,
  end: 3 * HOUR,
  allDay: false,
  location: '',
  notes: '',
  url: null,
  ...overrides,
});

const reader = (answer: (call: FakeCall) => { stdout?: string; stderr?: string; code?: number } | Error) => {
  const run = fakeRunner(answer);
  return { run, calendar: new MacCalendarReader({ run, log: memoryLogger(), platform: 'darwin' }) };
};

describe('MacCalendarReader when Calendar is slow', () => {
  it('answers a timed-out read with the last good one for the same hours', async () => {
    let slow = false;
    const { calendar } = reader(() => (slow ? { timedOut: true } : { stdout: granted([event()]) }));
    const first = await calendar.events(0, 10 * HOUR, null);
    slow = true;
    expect(await calendar.events(0, 10 * HOUR, null)).toEqual(first);
    // Other hours have no last good read to stand in
    await expect(calendar.events(HOUR, 10 * HOUR, null)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('forgets the last good read once access is gone', async () => {
    let answer: { stdout?: string; timedOut?: boolean } = { stdout: granted([event()]) };
    const { calendar } = reader(() => answer);
    await calendar.events(0, 10 * HOUR, null);
    answer = { stdout: JSON.stringify({ status: 0, calendars: [], events: [], truncated: false }) };
    await expect(calendar.events(0, 10 * HOUR, null)).rejects.toMatchObject({ kind: 'forbidden' });
    answer = { timedOut: true };
    await expect(calendar.events(0, 10 * HOUR, null)).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('parseCalendarOutput', () => {
  it('maps EventKit’s statuses to words', () => {
    expect(parseCalendarOutput('{"status":0}').access).toBe('not_determined');
    expect(parseCalendarOutput('{"status":1}').access).toBe('restricted');
    expect(parseCalendarOutput('{"status":2}').access).toBe('denied');
    expect(parseCalendarOutput('{"status":4}').access).toBe('write_only');
    expect(parseCalendarOutput('{"status":9}').access).toBe('unavailable');
    expect(parseCalendarOutput(granted()).access).toBe('granted');
  });

  it('says what to do when access is missing', () => {
    expect(parseCalendarOutput('{"status":0}').message).toMatch(/Privacy & Security › Calendars/);
    expect(parseCalendarOutput('{"status":2}').message).toMatch(/turn on “node”/);
    expect(parseCalendarOutput(granted()).message).toBeNull();
  });

  it('reads calendars and events, extracting the join link and capping text', () => {
    const read = parseCalendarOutput(
      granted([
        event({ id: 'E2@2', title: 'Later', start: 5 * HOUR, end: 6 * HOUR, location: 'https://zoom.us/j/123456' }),
        event({ notes: `Join: https://meet.google.com/abc-defg-hij.\n${'x'.repeat(5000)}` }),
        event({ id: 'E3', title: '', url: 'https://teams.microsoft.com/l/meetup-join/19%3a' }),
        event({ id: 'E4', start: 'soon' }),
        'junk',
      ]),
    );
    expect(read.calendars).toEqual([
      { id: 'cal-work', title: 'Work', account: 'avi@nexprove.com', color: null },
      { id: 'cal-home', title: 'Home', account: 'iCloud', color: null },
    ]);
    expect(read.events.map(item => [item.title, item.joinUrl])).toEqual([
      ['Standup', 'https://meet.google.com/abc-defg-hij'],
      ['Untitled event', 'https://teams.microsoft.com/l/meetup-join/19%3a'],
      ['Later', 'https://zoom.us/j/123456'],
    ]);
    expect(read.events[0].notes.length).toBe(CALENDAR_LIMITS.notesChars);
  });

  it('refuses output that is not its JSON', () => {
    expect(() => parseCalendarOutput('execution error')).toThrow(/could not read/);
  });
});

describe('meetingLinkIn', () => {
  it('takes only real meeting hosts', () => {
    expect(meetingLinkIn('at https://meet.google.com/abc-defg-hij)')).toBe('https://meet.google.com/abc-defg-hij');
    expect(meetingLinkIn('https://us02web.zoom.us/j/8812?pwd=x')).toBe('https://us02web.zoom.us/j/8812?pwd=x');
    expect(meetingLinkIn('https://evilzoom.us/j/1 https://meet.google.com.evil.example/abc-defg-hij')).toBeNull();
    expect(meetingLinkIn('http://meet.google.com/abc-defg-hij')).toBeNull();
    expect(meetingLinkIn('https://teams.live.com/meet/9381')).toBe('https://teams.live.com/meet/9381');
  });
});

describe('MacCalendarReader', () => {
  it('runs osascript with JavaScript and the window, never a shell', async () => {
    const { run, calendar } = reader(() => ({ stdout: granted([event()]) }));
    const read = await calendar.events(1000, 2000, ['cal-work']);
    expect(read.events).toHaveLength(1);
    expect(run.calls[0].command).toBe(OSASCRIPT);
    expect(run.calls[0].args.slice(0, 2)).toEqual(['-l', 'JavaScript']);
    expect(run.calls[0].args.slice(-4)).toEqual(['events', '1000', '2000', '["cal-work"]']);
  });

  it('refuses events without access, with the steps', async () => {
    const { calendar } = reader(() => ({ stdout: '{"status":2}' }));
    await expect(calendar.events(0, HOUR, null)).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('treats an Apple Events refusal as denied', async () => {
    const { calendar } = reader(() => ({
      code: 1,
      stderr: 'execution error: Not authorized to send Apple events (-1743)',
    }));
    expect((await calendar.status()).access).toBe('denied');
  });

  it('is unavailable off macOS or without osascript', async () => {
    const off = new MacCalendarReader({ run: fakeRunner(() => ({})), log: memoryLogger(), platform: 'linux' });
    expect((await off.status()).access).toBe('unavailable');
    const { calendar } = reader(() => new Error('spawn ENOENT'));
    expect((await calendar.status()).access).toBe('unavailable');
  });

  it('asks for access with the request mode', async () => {
    const { run, calendar } = reader(() => ({ stdout: granted() }));
    expect((await calendar.request()).access).toBe('granted');
    expect(run.calls[0].args.at(-1)).toBe('request');
  });
});

describe('MacCalendarReader when permission is lost', () => {
  const NOT_ASKED = JSON.stringify({ status: 0, calendars: [], events: [], truncated: false });
  const DENIED = JSON.stringify({ status: 2, calendars: [], events: [], truncated: false });

  it('names the program macOS asks about: Ava Brain under its app, otherwise node', async () => {
    expect(programName({ AVA_BRAIN_PROGRAM: 'Ava Brain' })).toBe('Ava Brain');
    expect(programName({})).toBe('node');
    expect(programName({ AVA_BRAIN_PROGRAM: '“”<>' })).toBe('node');
    const run = fakeRunner(() => ({ stdout: NOT_ASKED }));
    const underApp = new MacCalendarReader({
      run,
      log: memoryLogger(),
      platform: 'darwin',
      env: { AVA_BRAIN_PROGRAM: 'Ava Brain' },
    });
    const read = await underApp.status();
    expect(read.message).toMatch(/it names “Ava Brain”/);
    expect(read.message).not.toMatch(/node/);
  });

  it('says why when access granted before comes back not asked, and offers the prompt', async () => {
    let answer = granted();
    const { calendar } = reader(() => ({ stdout: answer }));
    expect((await calendar.status()).lost).toBeUndefined();
    answer = NOT_ASKED;
    const read = await calendar.status();
    expect(read).toMatchObject({ access: 'not_determined', lost: true });
    expect(read.message).toMatch(/macOS took the permission back/);
    expect(read.message).toMatch(/program Ava Brain runs as changes \(here “node”, so after every Node upgrade\)/);
    expect(read.message).toMatch(/Allow on the Mac/);
    await expect(calendar.events(0, HOUR, null)).rejects.toThrow(/macOS took the permission back/);
  });

  it('points to System Settings when the lost permission reads as denied', async () => {
    let answer = granted();
    const { calendar } = reader(() => ({ stdout: answer }));
    await calendar.status();
    answer = DENIED;
    const read = await calendar.status();
    expect(read).toMatchObject({ access: 'denied', lost: true });
    expect(read.message).toMatch(/System Settings › Privacy & Security › Calendars, turn on “node”/);
  });

  it('remembers across restarts that access was granted, in the data folder', async () => {
    const dir = tempDir();
    try {
      const make = (stdout: string) =>
        new MacCalendarReader({
          run: fakeRunner(() => ({ stdout })),
          log: memoryLogger(),
          platform: 'darwin',
          dataDir: dir.path,
        });
      expect((await make(NOT_ASKED).status()).lost).toBeUndefined();
      await make(granted()).status();
      const afterRestart = await make(NOT_ASKED).status();
      expect(afterRestart.lost).toBe(true);
    } finally {
      dir.remove();
    }
  });

  it('never calls a permission lost that was never given', async () => {
    const { calendar } = reader(() => ({ stdout: DENIED }));
    const read = await calendar.status();
    expect(read.lost).toBeUndefined();
    expect(read.message).toMatch(/does not let Ava Brain read/);
  });
});

describe('Calendar routes', () => {
  it('answer status and events to the paired extension only', async () => {
    const run = fakeRunner(call =>
      call.command === OSASCRIPT
        ? { stdout: granted([event({ location: 'https://meet.google.com/abc-defg-hij' })]) }
        : dockerUp(call),
    );
    const brain = await startTestBrain({ run, platform: 'darwin' });
    try {
      expect((await brain.api(CALENDAR_ROUTES.status, { token: null })).status).toBe(401);
      await brain.pair();
      const status = (await (await brain.api(CALENDAR_ROUTES.status)).json()) as {
        access: string;
        calendars: unknown[];
      };
      expect(status.access).toBe('granted');
      expect(status.calendars).toHaveLength(2);
      expect(status).toMatchObject({ lost: false });
      const events = await brain.api(CALENDAR_ROUTES.events, { body: JSON.stringify({ from: 0, to: HOUR * 24 }) });
      const body = (await events.json()) as { events: { joinUrl: string }[] };
      expect(body.events[0].joinUrl).toBe('https://meet.google.com/abc-defg-hij');
      const tooLong = await brain.api(CALENDAR_ROUTES.events, {
        body: JSON.stringify({ from: 0, to: HOUR * 24 * 40 }),
      });
      expect(tooLong.status).toBe(400);
    } finally {
      await brain.stop();
    }
  });
});
