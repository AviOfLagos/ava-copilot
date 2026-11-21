// A correction made once is only noted; made a second time it is saved (docs/pm-desk.md, Part 4.4). The count lives
// in storage.local so it survives the background restarting.
const KEY = 'vocab-pending-corrections';
const MAX_KEPT = 50;

type Pending = Record<string, { count: number; at: number }>;

const keyOf = (from: string, to: string, workspaceId: string | null) =>
  `${workspaceId ?? '*'}|${from.toLowerCase().trim()}|${to.toLowerCase().trim()}`;

async function read(): Promise<Pending> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as Pending | undefined) ?? {};
}

export const pendingCorrections = {
  /** Notes one more time that the user made this correction; returns how many times so far. */
  async see(from: string, to: string, workspaceId: string | null, confirmed = false): Promise<number> {
    const all = await read();
    const key = keyOf(from, to, workspaceId);
    const count = (all[key]?.count ?? 0) + 1;
    if (!confirmed) {
      all[key] = { count, at: Date.now() };
      // Only the latest few are worth keeping
      const kept = Object.entries(all)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, MAX_KEPT);
      await chrome.storage.local.set({ [KEY]: Object.fromEntries(kept) });
    }
    return count;
  },

  async clear(from: string, to: string, workspaceId: string | null): Promise<void> {
    const all = await read();
    delete all[keyOf(from, to, workspaceId)];
    await chrome.storage.local.set({ [KEY]: all });
  },
};
