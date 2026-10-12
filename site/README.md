# Avi Copilot website

The marketing and install site for Avi Copilot: `/`, `/install`, `/privacy`, a 404, `robots.txt`, a sitemap,
`llms.txt` and link-preview images. Static HTML, a few small islands, no analytics and nothing loaded from anyone
else. Decisions live in `docs/` (`BRIEF.md`, `DIRECTION.md`, `ARCHITECTURE.md`).

## Commands

Run from `site/` (its own package and lockfile; the extension's build is untouched). Node 22.12 or newer, pnpm 10.16
or newer (for `minimum-release-age` in `.npmrc`, which refuses versions published less than 72 hours ago).

| Command | What it does |
| --- | --- |
| `pnpm install` | Install the site's dependencies |
| `pnpm dev` | Dev server with hot reload (also reloads when the app's widgets in `../src` change) |
| `pnpm build` | Static build into `dist/`, then the link-preview images (see below) |
| `pnpm preview` | Serve `dist/` |
| `pnpm typecheck` | `tsc` over the site and the app files it imports |
| `pnpm og:update` | Build, render the link-preview images and copy them to `public/og/` (the committed fallback) |
| `pnpm verify` | The verification sweep against `dist/` (needs a local Chromium-family browser) |

On this machine pnpm goes through the snare guard: `snare shield check . >/dev/null && command pnpm <args>`.

Every script sets `ASTRO_TELEMETRY_DISABLED=1` (so does `astro.config.mjs`): Astro's CLI sends usage data by default.

## `SITE_URL`

One variable sets the canonicals, the sitemap, `robots.txt`, `llms.txt`, the OG image URLs and the host in the
install command. Default `https://avi-copilot.vercel.app`.

```bash
SITE_URL=https://avicopilot.example pnpm build
```

A shorter domain also helps the hero: the command block keeps the address on one line and breaks only between
`curl -fsSL`, the address and `| bash`.

## Where things are

```
src/content/site.ts     every word on the site (the content model); PRODUCT is the product name, in one place
src/pages/              index, install, privacy, 404, robots.txt, llms.txt, og-card/[slug] (OG templates)
src/layouts/Base.astro  metadata, JSON-LD, the no-flash theme script, header and footer
src/components/         Astro components; TrailExample.tsx is the app's run-trail step, rendered at build time
src/islands/            GateDemo (the hero), VoiceDemo (voice orb and dictation): the only client JavaScript
src/styles/             site.css (the site's tokens and components), demo.css, voice.css, og.css, tailwind.css
src/scripts/site.ts     theme switch, copy buttons, install tabs, one-time reveals
scripts/                app-i18n.mjs (Vite plugin), og.mjs, serve.mjs, verify.mjs
public/                 favicon, og/*.png (fallback previews)
```

`public/install.sh`, `public/install.ps1` and `public/download/**` belong to the distribution work and are not
written here; the site only links to `/install.sh` and `/download/latest.json`.

## How the app's widgets are reused

The site imports the extension's own components and CSS from `../src`, read-only, so it always looks like the panel:

- **Tokens:** `src/ui/lib/theme.css` is imported first; `site.css` adds the site's semantic layer (type scale,
  8 px spacing, surfaces) on top of it. Tailwind 3 mirrors the panel's theme (`tailwind.config.mjs`) and scans only
  the app files the site imports.
- **Aliases** (`astro.config.mjs`, repeated in `tsconfig.json`): `@app/*` is `../src/*`. `@extension/ui` is
  `src/lib/cn.ts`, the app's `cn` without tailwind-merge (8 KB gzipped saved; the widgets never get conflicting
  classes). `@extension/i18n` is a virtual module (`scripts/app-i18n.mjs`) that serves `t()` from
  `public/_locales/en/messages.json` at build time, with only the keys the imported files use, so the widgets show
  the same words as in the panel.
- **Dependencies** that files under `../src` import by bare name are deduped to the site's `node_modules`, and one
  tsconfig (the site's) is used for every file, because the extension's tsconfig extends a generated `.wxt/` file
  that a clean checkout does not have. The site builds without the extension's dependencies installed.

| Widget | Where | How |
| --- | --- | --- |
| Run trail: `ChainOfThought`, header, content, `ChainOfThoughtStep` | hero demo; the form example (build-time HTML) | imported |
| `ThinkingOrb` (+ `dotted-orb.ts`) | demo header and working row | imported; darkened with a CSS filter on the light theme |
| `HoldButton`, `Button` | the confirm card, "Run it again" | imported |
| `LiveOrb` (WebGL voice orb) | voice section | imported |
| `Composer` + `ListeningStrip` (`Dictation.tsx`) + `dictation.css` | voice section, with a simulated microphone | imported |
| `morph-orb.css` (the composer pill) | hero demo's composer | imported CSS, markup repeated (see below) |
| Confirm card | hero demo | `ConfirmCard`'s markup and classes repeated with the site's labels |

Two pieces repeat app markup instead of importing it: the confirm card (`ConfirmCard` reads its labels from
`chrome.i18n`: "Confirm" and "Cancel", where the site's direction asks for "Hold to send" and "Stop"), and the hero's
composer, which only ever shows a running task (disabled, with Stop), so the hero doesn't carry the dictation code.

## The gate demo

`src/islands/GateDemo.tsx`, hydrated on load. The page's HTML is the paused state (the trail with the amber diamond
and the confirm card), so it reads with JavaScript off. With scripts on, the parts the run will draw stay hidden until
the island takes over (`[data-pre]` in `demo.css`, revealed by CSS after 3.5 s if it never does), then the run plays
once when the demo is in view: steps fill node by node, the page is ringed where the agent acts, and it stops at the
card. Hold 0.8 s (mouse, touch, or Space/Enter held) or click twice to send; Stop sends nothing; "Run it again"
replays. Reduced motion: no run, the paused state at once. Phones: the mail page hides, the panel stays.

## Link previews

`scripts/og.mjs` runs after `astro build`: it serves `dist/`, screenshots `og-card/<slug>` at 1200×630 with
puppeteer-core and a local Brave, Chrome, Chromium or Edge (`CHROME_PATH` to pick one), writes `dist/og/*.png` and
deletes the card templates from `dist/`. No network, no third-party service. Where there is no browser (a CI image)
it keeps the committed images from `public/og/`; refresh those with `pnpm og:update` after changing the cards.

## Deploy (Vercel; nothing is deployed from here)

- Project root directory: `site`. Keep "Include files outside the root directory in the Build Step" on: the site
  imports `../src` and `../public/_locales`.
- `vercel.json` sets the framework, install and build commands, clean URLs without trailing slashes (the canonicals
  use `/install`, `/privacy`), long caching for `/_astro/*`, and security headers, including a CSP that allows
  only this origin (`'unsafe-inline'` stays for Astro's island bootstrap and the no-flash theme script).
- Set `SITE_URL` to the production origin. Node 22+, pnpm 10.16+ (`ENABLE_EXPERIMENTAL_COREPACK=1` uses the pinned
  `packageManager`).
- Any other static host works: serve `dist/` with `install.html` at `/install` and `404.html` for misses
  (`scripts/serve.mjs` does exactly that).

## Verification

`pnpm verify` (`scripts/verify.mjs`, the award-tier-ui sweep on puppeteer-core) screenshots every route at 390, 768,
1280 and 1440 px in dark and light, plus reduced-motion, no-JavaScript and forced-colors renders, and checks: HTTP
status, console and page errors (including CSP refusals, since `serve.mjs` applies `vercel.json`'s headers), requests
to other origins, horizontal overflow, one `<h1>`, canonical/robots/OG tags, a visible focus ring, no animation
running under reduced motion, the install tabs and theme switch, the demo by mouse hold, short press then click,
Space, Enter, Stop, the composer's Stop and touch, lab CLS and LCP (desktop; phone at 4x CPU on Slow 4G),
`robots.txt`, the sitemap, `llms.txt` and the OG images. `SHOTS=<dir>` puts the screenshots elsewhere.

## Stack decision record

```
Rendering: static (SSG) with islands — Astro, React islands for the demo and orbs
Signals: public pages, links pasted into chats, content will grow (changelog, docs), LLM discoverability,
         link previews — score 5
Rejected: Vite SPA (fails every signal); Next.js (works, but ships more JS for a content site)
Consequence: all copy is in the HTML; islands only for the demo and the voice vignette; copy buttons, tabs and the
             theme switch are a few lines of plain script
```

Versions: Astro 7.3.8, @astrojs/react 7.0.1, @astrojs/sitemap 3.7.4, React 18.3.1 (as the extension), Tailwind 3.4.18
(as the extension), Geist and Geist Mono variable fonts from Fontsource 5.3.0, self-hosted.

Budgets, measured on the build: the hero's JavaScript is about 62 KB gzipped (React and React DOM are 45 of it);
the voice island loads only when it scrolls into view. Lab LCP 1.8 s on a phone profile (4x CPU, Slow 4G), CLS under
0.03.
