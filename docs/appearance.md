# Appearance settings (theme, text size, spacing)

One small record, kept apart from any page's CSS so the Ava desktop app can carry it over unchanged.

- **Record**: `AppearanceSettingsConfig` in `src/storage/lib/settings/appearanceSettings.ts`, stored in
  `storage.local` under `appearance-settings` and live-synced across the side panel, settings page and other pages.
  - `theme`: `dark` (default, as before) | `light` | `system`
  - `textScale`: percent, one of 85, 90, 100, 110, 120, 130 (`TEXT_SCALES`)
  - `density`: `compact` (0.85) | `comfortable` (1) | `roomy` (1.15)
- **Pure functions** (no DOM, no Chrome API): `normalizeAppearance`, `stepTextScale`, `resolveTheme`,
  `appearanceCss`. They turn the record into three values: the resolved theme, a zoom factor and a spacing factor.
  Anything stored that is not valid is repaired on read.
- **Applying it on a page** (`src/side-panel/layout/theme.ts`, `useAppearance`): `data-theme` on `<html>`, `zoom` on
  `<html>` (so text, icons and the many fixed pixel sizes scale together), `--density` (read by the Tailwind spacing
  scale in `src/ui/lib/density.ts`), and `--ui-zoom` (so `h-screen` and `min-h-screen` are divided by the zoom).
  The last record is cached in the page's `localStorage` so a page paints correctly before storage answers.
- **Controls**: Settings → General → Look (theme, text size slider, spacing) and A−/A+ in the side panel header.

## Carrying it to the desktop app

The desktop app should read and write the same record (same field names and values), reuse `appearanceCss`, and
apply the three values with whatever its shell offers: its web view's CSS if it renders the same pages, otherwise
the native equivalents (theme, scale factor, spacing multiplier). Do not add panel-only knobs: add a field to the
record, to `normalizeAppearance` and to its test, so both apps keep agreeing.
