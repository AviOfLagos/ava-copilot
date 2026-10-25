/**
 * What's new, for the extension's update checker (src/background/update/check.ts reads version.json.ts, which
 * reads this). The version number itself always comes from the repo's own package.json (see site.ts's VERSION);
 * only these two fields are maintained by hand, and only need updating alongside a real version bump
 * (`pnpm update-version`) — see docs/task.md for the release checklist.
 */
export const RELEASE = {
  released: '2026-10-25',
  notes: [
    'Nex Copilot is now Ava Copilot, at ava.nexprove.com. Your chats, memory and settings stay as they are.',
    'Ambient listening: Ava can write down what is said around you, on your computer only, with “off the record”.',
    'Report a problem from Settings › Help: it opens a GitHub issue with your version and browser filled in.',
  ],
};
