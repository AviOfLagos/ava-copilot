/**
 * What's new, for the extension's update checker (src/background/update/check.ts reads version.json.ts, which
 * reads this). The version number itself always comes from the repo's own package.json (see site.ts's VERSION);
 * only these two fields are maintained by hand, and only need updating alongside a real version bump
 * (`pnpm update-version`) — see docs/task.md for the release checklist.
 */
export const RELEASE = {
  released: '2026-10-25',
  notes: [
    'After an update, the panel now shows what changed, with one desktop notification.',
    'Answers read aloud use a voice on your computer (KittenTTS or Kokoro) instead of the browser’s, when one is installed.',
    'Settings › Voice output: pick the voice for every engine (KittenTTS, Kokoro, Gemini or system), with a Preview button.',
  ],
};
