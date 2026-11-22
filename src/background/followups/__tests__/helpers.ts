import type { Task } from '@extension/storage';

// Shared by the follow-up tests: local dates on a fake calendar. 2026-11-23 is a Monday.
export const at = (day: number, hour = 9, month = 10, year = 2026) => new Date(year, month, day, hour, 0).getTime();
// November 2026
export const nov = (day: number, hour = 9) => at(day, hour);

export function makeTask(fields: Partial<Task> = {}): Task {
  return {
    id: 'tsk_aaaaaaaaaa',
    title: 'Send the deck to the venue',
    workspaceId: null,
    workspaceSetBy: 'rule',
    ownerId: null,
    ownerName: 'Ada',
    status: 'open',
    source: { kind: 'manual' },
    seenIn: [],
    links: [],
    externalRefs: [],
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}
