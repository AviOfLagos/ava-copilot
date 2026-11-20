import { beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter(key => key in data)
              .map(key => [key, data[key]]),
          ),
        set: async (items: Record<string, unknown>) => void Object.assign(data, items),
        remove: async (key: string) => void delete data[key],
        onChanged: { addListener: () => undefined },
      },
      session: { get: async () => ({}), set: async () => undefined },
    },
    notifications: { create: async () => '', clear: async () => true },
    runtime: { getURL: (path: string) => path },
    i18n: { getMessage: (key: string) => key },
  });
  return data;
});

// The calendar the watcher reads: connected or not, answering or failing
const calendar = vi.hoisted(() => ({
  connected: true,
  fail: null as string | null,
  events: [] as {
    id: string;
    title: string;
    start: number;
    end: number;
    allDay: boolean;
    location: string;
    joinUrl: string | null;
  }[],
}));
vi.mock('../sources', () => ({
  planSources: () => (calendar.connected ? ['ics'] : []),
  icsSource: () => ({ name: 'ics' }),
  macSource: () => ({ name: 'mac' }),
  readFromSources: async () =>
    calendar.fail
      ? { events: [], source: null, error: calendar.fail }
      : { events: calendar.events, source: 'ics', error: null },
}));
vi.mock('../../companion/client', () => ({ companionClient: {} }));
vi.mock('../../companion/state', () => ({ brainSettingsStore: { getSettings: async () => ({ paired: false }) } }));

const { CalendarWatcher } = await import('../watcher');
const { upcomingEventsStore } = await import('@extension/storage');

const HOUR = 3_600_000;
const standup = () => ({
  id: 'standup',
  title: 'Standup',
  start: Date.now() + HOUR,
  end: Date.now() + 2 * HOUR,
  allDay: false,
  location: 'Room 2',
  joinUrl: 'https://meet.example/abc',
});

beforeEach(async () => {
  for (const key of Object.keys(data)) delete data[key];
  calendar.connected = true;
  calendar.fail = null;
  calendar.events = [standup()];
  await upcomingEventsStore.set({ events: [], readAt: 0, error: null, source: null });
});

/**
 * Calendar events are stored, so a background restart does not empty them (docs/growth-team.md, Part 5a,
 * issue #67). A new CalendarWatcher is what a restarted background has.
 */
describe('the calendar across a background restart', () => {
  it('still has the day it read before the restart, when the calendar cannot be read after it', async () => {
    const before = new CalendarWatcher();
    expect(await before.refresh()).toBeNull();
    const readAt = (await upcomingEventsStore.get()).okAt;
    expect(readAt).toBeGreaterThan(0);

    // The background restarts, and the calendar does not answer (the Mac's permission is gone)
    calendar.fail = 'Ava Brain may not read the Calendar';
    const after = new CalendarWatcher();
    const reading = await after.reading(24);
    expect(reading.state).toBe('failed');
    expect(reading.error).toBe('Ava Brain may not read the Calendar');
    expect(reading.events.map(event => event.title)).toEqual(['Standup']);
    expect(reading.asOf).toBe(readAt);
    // What a reminder needs came back too
    expect(reading.events[0]).toMatchObject({ allDay: false, location: 'Room 2', joinUrl: 'https://meet.example/abc' });

    // ...and the failed read did not write an empty day over the stored one
    const stored = await upcomingEventsStore.get();
    expect(stored.events.map(event => event.title)).toEqual(['Standup']);
    expect(stored.error).toBe('Ava Brain may not read the Calendar');
    expect(stored.okAt).toBe(readAt);
    expect((await after.upcoming(24)).map(event => event.title)).toEqual(['Standup']);
  });

  it('reads fresh events over the stored ones once the calendar answers again', async () => {
    await new CalendarWatcher().refresh();
    calendar.events = [{ ...standup(), id: 'review', title: 'Review' }];
    const reading = await new CalendarWatcher().reading(24);
    expect(reading.state).toBe('read');
    expect(reading.events.map(event => event.title)).toEqual(['Review']);
  });
});

describe('a calendar that is not connected', () => {
  it('says so, instead of an empty day that reads as a free one', async () => {
    calendar.connected = false;
    const reading = await new CalendarWatcher().reading(24);
    expect(reading).toEqual({ state: 'not_connected', events: [], error: null, asOf: null });
  });

  it('is told apart from a connected calendar with nothing on it', async () => {
    calendar.events = [];
    const reading = await new CalendarWatcher().reading(24);
    expect(reading.state).toBe('read');
    expect(reading.events).toEqual([]);
  });
});
