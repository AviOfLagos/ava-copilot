/**
 * What's new, for the extension's update checker (src/background/update/check.ts reads version.json.ts, which
 * reads this). The version number itself always comes from the repo's own package.json (see site.ts's VERSION);
 * only these two fields are maintained by hand, and only need updating alongside a real version bump
 * (`pnpm update-version`) — see docs/task.md for the release checklist.
 */
export const RELEASE = {
  released: '2026-10-25',
  notes: [
    'Voice no longer gets stuck: if speech recognition stalls, it restarts on its own and Ava listens again.',
    'A turn that takes over two minutes ends with “That took too long”, instead of blocking the conversation.',
  ],
};
