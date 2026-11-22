import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';

// Which tasks today's follow-ups are (docs/pm-desk.md, Part 9.2): at most five a day, picked once and kept, so the
// brief, WhatsApp and the Inbox show the same ones. Kept in `storage.local`; the background is the only writer.

export interface FollowUpDayState {
  day: string;
  taskIds: string[];
  // The day the Inbox item was last made for
  inboxDay?: string;
}

const empty: FollowUpDayState = { day: '', taskIds: [] };

const storage = createStorage<FollowUpDayState>('followup-day', empty, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const followUpDayStore = {
  get: async (): Promise<FollowUpDayState> => (await storage.get()) ?? empty,
  set: (state: FollowUpDayState) => storage.set(state),
};

/** Pages follow the day's picks live (`useStorage`). */
export const followUpDayStorage = storage;
