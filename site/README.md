# Nex Copilot website

The marketing and install site for Nex Copilot: `/`, `/install`, `/privacy`, a 404, `robots.txt`, a sitemap,
`llms.txt` and link-preview images. Static HTML, a few small islands and scripts, no analytics and nothing loaded from
anyone else. Decisions live in `docs/` (`BRIEF.md`, `DIRECTION.md` — v2, "Ava gives the tour" — and
`ARCHITECTURE.md`).

The home page is built around the assistant's globe (the app's own dotted orb) and Ava's narrated tour: each section
is a numbered pill, a short two-tone headline, at most one sentence, and a working widget made from the app's parts.

## Commands

Run from `site/` (its own package and lockfile; the extension's build is untouched). Node 22.12 or newer, pnpm 10.16
or newer (for `minimum-release-age` in `.npmrc`, which refuses versions published less than 72 hours ago).

| Command | What it does |
| --- | --- |
| `pnpm install` | Install dependencies |
| `pnpm dev` | Dev server with hot reload (also reloads when the app's widgets in `../src` change) |
| `pnpm build` | Static build into `dist/`, then the link-preview images (see below) |
| `pnpm preview` | Serve `dist/` |
| `pnpm typecheck` | `tsc` over the site and the app files it imports |
| `pnpm og:update` | Build, render the link-preview images and copy them to `public/og/` (the committed fallback) |
| `pnpm verify` | The verification sweep against `dist/` (needs a local Chromium-family browser) |
| `pnpm narrate` | Record Ava's lines that changed, with the app's local Kokoro voice (see "The tour") |
| `pnpm render:3d` | Render the glass objects to `public/3d/` (see "3D") |

On this machine pnpm goes through the snare guard: `snare shield check . >/dev/null && command pnpm <args>`.

Every script sets `ASTRO_TELEMETRY_DISABLED=1` (so does `astro.config.mjs`): Astro's CLI sends usage data by default.

## `SITE_URL`

One variable sets the canonicals, the sitemap, `robots.txt`, `llms.txt`, the OG image URLs and the host in the
install command. Default `https://nex-copilot.vercel.app`.

```bash
SITE_URL=https://avicopilot.example pnpm build
```

## Where things are

```text
src/content/site.ts              every word on the site (the content model); PRODUCT is the product name, in one place
src/content/narration.json       Ava's lines, one per section (`text` is shown, `say` is what the voice reads if different)
src/content/narration-audio.json written by `pnpm narrate`: each line's file, length and the hash of what was said
src/pages/                       index, install, privacy, 404, robots.txt, llms.txt, og-card/[slug] (OG templates)
src/layouts/Base.astro           metadata, JSON-LD, the no-flash theme script, header, footer, the `after` slot
src/components/                  Section (pill + headline + sentence), Globe, TourDock, Flutes, and the widgets:
                                 TrailRun.tsx (build-time), StepsBento, KnowledgeGraph, RoutineFlow, InboxStack,
                                 ModelPicker, Integrations, Stats, TaskList, PrivacyLabel, Faq, InstallCommand
src/islands/                     GateDemo (section 01), VoiceDemo (section 03): the only React that ships
src/scripts/                     site.ts (every page: theme, copy, tabs); globe.ts, tour.ts, widgets.ts (home)
src/lib/                         globe-still.ts (the globe's build-time frame), marks.ts (simple-icons), seo.ts, icons.ts
src/styles/                      site.css (tokens, shared parts, inner pages), home.css (the home page), demo.css,
                                 voice.css, og.css, tailwind.css
scripts/                         narrate.mjs, render-3d.mjs, og.mjs, verify.mjs, serve.mjs, app-i18n.mjs
public/audio/                    the tour's recordings (AAC, committed)
public/3d/                       the glass objects (WebP with transparency, committed)
```

`public/install.sh`, `public/install.ps1` and `public/download/**` belong to the distribution work and are not
written here; the site only links to `/install.sh` and `/download/latest.json`.

## How the app's widgets are reused

The site imports the extension's own components and CSS from `../src`, read-only, so it always looks like the panel:

- **Tokens:** `src/ui/lib/theme.css` is imported first; `site.css` adds the site's semantic layer (type scale,
  8 px spacing, surfaces) on top of it. Tailwind 3 mirrors the panel's theme (`tailwind.config.mjs`) and scans only
  the app files the site imports.
- **Aliases** (`astro.config.mjs`, repeated in `tsconfig.json`): `@app/*` is `../src/*`. `@extension/ui` is
  `src/lib/cn.ts`, the app's `cn` without tailwind-merge. `@extension/i18n` is a virtual module
  (`scripts/app-i18n.mjs`) that serves `t()` from `public/_locales/en/messages.json` at build time, with only the keys
  the imported files use, so the widgets say what the panel says.
- **Dependencies** that files under `../src` import by bare name are deduped to the site's `node_modules`; one
  tsconfig (the site's) is used for every file. The site builds without the extension's dependencies installed (only
  `pnpm narrate` needs them).

| Widget | Where | How |
| --- | --- | --- |
| Dotted orb (`dotted-orb.ts`) | the globe; its build-time still | imported; run live, and once at build into a recording 2D context |
| Run trail: `ChainOfThought`, `ChainOfThoughtStep` | gate demo; the section 02 run (build-time HTML) | imported |
| `ThinkingOrb`, `HoldButton`, `Button` | gate demo | imported |
| `Button` and `buttonClasses` | section 02 run ("Your turn" card), the Inbox stack | imported |
| `LiveOrb`, `Composer` + `ListeningStrip` | voice section, with a simulated microphone | imported |
| Confirm card, "Your turn" card | gate demo, section 02 | `ConfirmCard`'s markup and classes repeated with the site's labels |
| Workflow node card | section 05 routine | `FlowDiagram`'s node markup and classes repeated (React Flow is too heavy for a page) |
| Inbox row | section 05 | `InboxRow`'s markup repeated, the app's buttons and labels |

## The globe

`src/components/Globe.astro` + `src/scripts/globe.ts`. The page's 3D object is the app's dotted orb
(`src/side-panel/components/ui/dotted-orb.ts`, imported unchanged), 600 px wide.

- **Static first frame.** At build, `src/lib/globe-still.ts` runs the orb's own drawing code once into a 2D context
  that records its dots, and the page ships them as an inline SVG in `currentColor`. It is there without JavaScript
  and under reduced motion; the canvas takes over on the frame it draws the same picture.
- **It follows the page** (≥ 900 px, motion allowed): the globe becomes a clipped, viewport-sized layer and its body
  glides on a critically damped spring (transform only) to the spot the section in the middle of the screen names in
  `data-globe` (`hero`, `peek`, `left`, `right`, `low`, `away`), level with that section's headline, and changes light
  program with `data-state` (`listening`, `thinking`, `acting`, `done`). Scrolling spins it a little faster.
- **Phones:** one spot, in the hero; it draws only while on screen. **Reduced motion:** the SVG frame, still.
  **Hidden tab:** animation frames stop; the orb's loop also stops itself whenever the globe can't be seen.
- Layers inside `<main>`: fluted glass −3, the hero wordmark −2, the globe −1, content above; glass cards frost it.

## The tour

`src/components/TourDock.astro` + `src/scripts/tour.ts`; lines in `src/content/narration.json`.

- Nothing plays, and no recording is requested, before "Listen to the tour". After it, each section's line plays as
  the section reaches the middle of the screen: one at a time (a new section fades the last line out after a short
  settle), lines already heard don't repeat. The dock shows the line as a caption with Pause and Stop; the globe
  speaks to the audio's level (an `AnalyserNode`). A hidden tab pauses it and it resumes on return; Esc stops it.
  If a recording is missing, the words show for as long as they would take to say.
- Every line is also in the HTML: the "Read the tour" transcript at the close (and the dock's caption).

### Regenerating the narration

Ava's voice is **Kokoro 82M v1.0 (int8), voice `af_heart`** (Apache-2.0) — the app's default local voice, run by the
app's own TTS worker (`src/offscreen/tts-local/tts.worker.ts`, unchanged). macOS system voices are never used for
published audio: their licence does not allow it.

```bash
# once, at the repo root: the extension's dependencies and the Kokoro model files
snare shield check . >/dev/null && command pnpm install
node scripts/voice-models-setup.mjs --kokoro        # or point VOICE_DIR at a folder that holds kokoro/

# then, in site/
pnpm narrate              # lines whose words or voice changed, or whose file is missing
pnpm narrate --all        # every line
pnpm narrate hero gate    # just these
pnpm narrate --check      # exit 1 when a line's audio is out of date (the build also warns)
```

`scripts/narrate.mjs` bundles the worker with the root's Vite, runs it in headless Brave (`CHROME_PATH` to choose a
browser), joins each line's sentences with a short breath, levels every line to the same loudness, writes WAV and
encodes AAC with `afconvert -f m4af -d aac -b 64000` (or `ffmpeg` elsewhere) into `public/audio/<id>-<hash>.m4a`. The
hash is of the words read, the voice and the speed, so a changed line gets a new file name (no stale cache). Ten lines
are about 85 s and 700 KB; they load only after the click, one ahead of the one playing.

## 3D

Besides the globe: fluted glass light panels in CSS (`src/components/Flutes.astro`, `home.css`: a coloured light
behind repeating-gradient ribs, a lit edge, a frosted backdrop for the ones in front), with gentle parallax from CSS
scroll-driven animations where the browser has them (static under reduced motion). And three glass objects rendered
offline: an amber diamond (the commit point, beside the gate), a mint pill (the composer, behind the model picker)
and a periwinkle ring (voice, behind the voice card).

```bash
pnpm render:3d            # all three at 720 px; the diamond and the pill also at 192 px, for the headline pills
pnpm render:3d diamond    # one
```

`scripts/render-3d.mjs` runs three.js (a devDependency; it never ships) in headless Brave: each object is drawn once
lit, with a banded coloured light behind it that the glass refracts, and once as a silhouette; the two are combined
into a WebP with transparency (dark parts of the glass let the page show through). About 6–48 KB each.

## Link previews

`scripts/og.mjs` runs after `astro build`: it serves `dist/`, screenshots `og-card/<slug>` at 1200×630 with
puppeteer-core and a local Brave, Chrome, Chromium or Edge (`CHROME_PATH` to pick one), writes `dist/og/*.png` and
deletes the card templates from `dist/`. No network, no third-party service. Where there is no browser it keeps the
committed images from `public/og/`; refresh those with `pnpm og:update` after changing the cards.

## Deploy (Vercel; nothing is deployed from here)

- Project root directory: `site`. Keep "Include files outside the root directory in the Build Step" on: the site
  imports `../src` and `../public/_locales`.
- `vercel.json` sets the framework, install and build commands, clean URLs without trailing slashes, long caching for
  `/_astro/*`, and security headers, including a CSP that allows only this origin (`media-src` falls back to it, so
  the recordings play; `'unsafe-inline'` stays for Astro's island bootstrap and the no-flash theme script).
- Set `SITE_URL` to the production origin. Node 22+, pnpm 10.16+.
- Any other static host works: serve `dist/` with `install.html` at `/install` and `404.html` for misses
  (`scripts/serve.mjs` does exactly that).

## Verification

`pnpm verify` (`scripts/verify.mjs`, the award-tier-ui sweep on puppeteer-core) screenshots every route at 390, 768,
1280 and 1440 px in dark and light; every home section at 1440 and 390 in both themes with the globe in its spot; the
tour playing; reduced-motion, no-JavaScript and forced-colours renders. It checks HTTP status, console and page
errors (including CSP refusals, since `serve.mjs` applies `vercel.json`'s headers), requests to other origins,
horizontal overflow, one `<h1>`, canonical/robots/OG tags, a visible focus ring, no animation running under reduced
motion; that the globe follows the page on wide screens and not on phones, sits left or right as each section says
and never covers a headline; the tour (no audio before the click, the right line playing alone as you scroll,
captions, Pause, a hidden tab, Esc, Stop by keyboard, the transcript); the widgets (the run's sign-in hand-back and
Submit wait, the graph, the routine, the Inbox, the model picker, the task preview); the gate demo by mouse hold,
short press then click, Space, Enter, Stop, the composer's Stop and touch; lab CLS and LCP (desktop; phone at 4x CPU
on Slow 4G); the initial JavaScript, gzipped; `robots.txt`, the sitemap, `llms.txt` and the OG images.
`SHOTS=<dir>` puts the screenshots elsewhere.

## Stack decision record

```text
Rendering: static (SSG) with islands — Astro, React islands for the gate demo and the voice vignette
Signals: public pages, links pasted into chats, content will grow (changelog, docs), LLM discoverability,
         link previews — score 5
Rejected: Vite SPA (fails every signal); Next.js (works, but ships more JS for a content site)
Consequence: all copy is in the HTML; the globe, the tour and the small widgets are plain scripts over build-time
             HTML; React ships only for the gate demo (on load) and the voice vignette (when it comes into view)
```

Versions: Astro 7.3.8, @astrojs/react 7.0.1, @astrojs/sitemap 3.7.4, React 18.3.1 (as the extension), Tailwind 3.4.18
(as the extension), Geist and Geist Mono variable fonts from Fontsource 5.3.0 (self-hosted), simple-icons 16.34.0
(CC0, build time only), three 0.186.1 (devDependency, `render:3d` only).
