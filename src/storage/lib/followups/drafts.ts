import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';

// The follow-up messages already worded (docs/pm-desk.md, Part 9.3): one per task and set of facts, so the same facts
// never call the model twice. Kept in `storage.local`; the background is the only writer.

export interface FollowUpDraftEntry {
  // The facts the text was made from, as one string: other facts, another draft
  key: string;
  text: string;
  byModel: boolean;
  at: number;
}

export type FollowUpDraftCache = Record<string, FollowUpDraftEntry>;

export const MAX_DRAFT_ENTRIES = 50;

const storage = createStorage<FollowUpDraftCache>(
  'followup-drafts',
  {},
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export const followUpDraftStore = {
  /** The kept draft for this task, only when it was made from these facts. */
  async get(taskId: string, key: string): Promise<FollowUpDraftEntry | null> {
    const entry = ((await storage.get()) ?? {})[taskId];
    return entry && entry.key === key ? entry : null;
  },
  /** Keeps a draft; the oldest go once there are more than 50. */
  async set(taskId: string, entry: FollowUpDraftEntry): Promise<void> {
    const all = { ...((await storage.get()) ?? {}), [taskId]: entry };
    const ids = Object.keys(all);
    if (ids.length > MAX_DRAFT_ENTRIES) {
      ids
        .sort((a, b) => all[a].at - all[b].at)
        .slice(0, ids.length - MAX_DRAFT_ENTRIES)
        .forEach(id => delete all[id]);
    }
    await storage.set(all);
  },
};
