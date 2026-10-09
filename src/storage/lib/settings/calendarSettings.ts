import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export interface CalendarSettingsConfig {
  // The calendar's private iCal address (Google Calendar: Settings → the calendar → "Secret address in iCal format")
  icsUrl: string;
  // How long before a meeting the reminder comes
  remindMinutes: number;
  reminders: boolean;
}

export const DEFAULT_CALENDAR_SETTINGS: CalendarSettingsConfig = {
  icsUrl: '',
  remindMinutes: 5,
  reminders: true,
};

export type CalendarSettingsStorage = BaseStorage<CalendarSettingsConfig> & {
  getSettings: () => Promise<CalendarSettingsConfig>;
  updateSettings: (changes: Partial<CalendarSettingsConfig>) => Promise<void>;
};

const storage = createStorage<CalendarSettingsConfig>('calendar-settings', DEFAULT_CALENDAR_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const calendarSettingsStore: CalendarSettingsStorage = {
  ...storage,
  async getSettings() {
    return { ...DEFAULT_CALENDAR_SETTINGS, ...(await storage.get()) };
  },
  async updateSettings(changes) {
    await storage.set({ ...(await calendarSettingsStore.getSettings()), ...changes });
  },
};

export interface UpcomingEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  joinUrl: string | null;
}

// What the background last read from the calendar, for the panel to show without fetching
export const upcomingEventsStore = createStorage<{ events: UpcomingEvent[]; readAt: number; error: string | null }>(
  'calendar-upcoming',
  { events: [], readAt: 0, error: null },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);
