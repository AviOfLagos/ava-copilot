/**
 * What's new, for the extension's update checker (src/background/update/check.ts reads version.json.ts, which
 * reads this). The version number itself always comes from the repo's own package.json (see site.ts's VERSION);
 * only these two fields are maintained by hand, and only need updating alongside a real version bump
 * (`pnpm update-version`) — see docs/task.md for the release checklist.
 */
export const RELEASE = {
  released: '2026-10-22',
  notes: [
    "Settings cards reach the background: WhatsApp, Ava's Meet browser, the Mac's Calendar, Obsidian, connectors, Drive and skills.",
    'Ollama and LM Studio answer the extension with nothing to set.',
    'Nex Brain pairs with one click — no code to type.',
  ],
};
