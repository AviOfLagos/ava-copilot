# Architecture — routes, content, stack

## Routes

| Route | Job | Primary action | Source | Index |
|---|---|---|---|---|
| `/` | Say what it is, show the gate working, earn trust | Copy the install command | content model | yes |
| `/install` | Get it running on macOS, Linux or Windows, update and remove it; the optional Mac companion | Copy the command | content model | yes |
| `/privacy` | What it stores, what leaves the machine, what never does; permissions explained | — | content model | yes |
| `/404` | Get back home | Home | static | noindex |
| `/install.sh` | The install script (owned by the distribution work) | — | file | n/a |
| `/download/latest.json`, `/download/*.zip` | Release metadata and builds (distribution work) | — | file | n/a |
| `/robots.txt`, `/sitemap-index.xml`, `/llms.txt`, `/og/*.png` | Discovery | — | generated | n/a |

No trailing slashes (`/install`), apex domain, self-referencing canonicals, `noindex` only on 404.

## Content model

`site/src/content/site.ts` holds every string and record: product (name, tagline, description, version), install
commands per OS, the home sections (id, number, pill, two-tone title, one sentence, the widget's copy), models
(name, host, kind: local | cloud), connectors (name, mark, built in | by address), true numbers, tasks, privacy facts
(stays / leaves / never), permissions (name, why), FAQ (q, a), links, the tour's labels. Components only read from it.

Ava's narration is `site/src/content/narration.json` (one line per section; `text` shown, `say` read when they
differ), read by the content model (captions, transcript) and by `scripts/narrate.mjs` (the recordings). The
recordings' manifest, `narration-audio.json`, is written by that script; the build warns when a line changed since
it was recorded.

v2 adds no routes. The home page's sections, in order: hero, 01 gate, 02 every step, 03 voice, 04 memory, 05
routines and agents, 06 models, 07 integrations, the numbers, 08 privacy, the task list, questions, the close.

## Stack decision record

```
Rendering: static (SSG) with islands — Astro, React islands for the demo and orbs
Signals: public pages (1), links pasted into chats (2), content will grow — changelog, docs (3),
         LLM discoverability (8), link previews (10) — score 5
Rejected: Vite SPA (fails every signal); Next.js (works, but ships more JS for a content site)
Consequence: all copy is in the HTML; islands only for the gate demo and the voice vignette; the globe (the app's
             dotted orb), the tour and the small widgets are plain scripts over build-time HTML
```

- Build-time only: simple-icons (connector and model marks, inlined as SVG), three.js (the glass objects, rendered
  to WebP by `scripts/render-3d.mjs`), Kokoro through the app's own TTS worker (the narration, `scripts/narrate.mjs`).
  None of them ships to the browser.

- Astro (static output) + `@astrojs/react`; the app's React widgets and CSS are imported from `../src` (the orbs
  need only React and `cn`), so the site always looks like the app. `@astrojs/sitemap`.
- Fonts: `@fontsource-variable/geist` and `geist-mono`, self-hosted, as in the app.
- OG images: 1200×630 PNGs generated at build without a third-party service.
- Hosting: any static host (Vercel planned). `SITE_URL` sets canonicals, sitemap and the install command's host.

## Metadata plan

| Route | Answers | Title | H1 idea |
|---|---|---|---|
| `/` | "AI browser agent extension that asks before acting" | Nex Copilot — the AI browser copilot that waits for your click | What it is + the gate, in one line |
| `/install` | "install Nex Copilot" | Install Nex Copilot — one command for Brave, Chrome and Edge | Install Nex Copilot |
| `/privacy` | "Nex Copilot privacy" | Privacy — Nex Copilot | What stays on your machine |

JSON-LD: one `@graph` with `WebSite`, `SoftwareApplication` (browser extension, free `Offer`, operating systems),
`FAQPage` on `/`, `BreadcrumbList` on inner pages.

## Quality gates for v1

WCAG 2.2 AA (keyboard, visible focus, contrast in both themes, reduced motion), no console errors, every route
200, OG images resolve, sitemap/robots correct, one `<h1>` per page, the hero readable with JavaScript off,
Lighthouse ≥ 95 (performance, accessibility, SEO), the skill's `verify.mjs` sweep (routes × breakpoints × themes).

## Responsive

The demo keeps working on phones: the mock page hides and the panel stays, with touch-and-hold on the button.
Sections stack into one column under 860 px.
