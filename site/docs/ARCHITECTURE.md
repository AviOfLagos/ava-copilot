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
commands per OS, features (id, title, body, widget), models (name, kind: local | cloud), privacy facts (stays /
leaves / never), permissions (name, why), FAQ (q, a), links. Components only read from it.

## Stack decision record

```
Rendering: static (SSG) with islands — Astro, React islands for the demo and orbs
Signals: public pages (1), links pasted into chats (2), content will grow — changelog, docs (3),
         LLM discoverability (8), link previews (10) — score 5
Rejected: Vite SPA (fails every signal); Next.js (works, but ships more JS for a content site)
Consequence: all copy is in the HTML; islands only for the demo, orbs and copy buttons
```

- Astro (static output) + `@astrojs/react`; the app's React widgets and CSS are imported from `../src` (the orbs
  need only React and `cn`), so the site always looks like the app. `@astrojs/sitemap`.
- Fonts: `@fontsource-variable/geist` and `geist-mono`, self-hosted, as in the app.
- OG images: 1200×630 PNGs generated at build without a third-party service.
- Hosting: any static host (Vercel planned). `SITE_URL` sets canonicals, sitemap and the install command's host.

## Metadata plan

| Route | Answers | Title | H1 idea |
|---|---|---|---|
| `/` | "AI browser agent extension that asks before acting" | Avi Copilot — the AI browser copilot that waits for your click | What it is + the gate, in one line |
| `/install` | "install Avi Copilot" | Install Avi Copilot — one command for Brave, Chrome and Edge | Install Avi Copilot |
| `/privacy` | "Avi Copilot privacy" | Privacy — Avi Copilot | What stays on your machine |

JSON-LD: one `@graph` with `WebSite`, `SoftwareApplication` (browser extension, free `Offer`, operating systems),
`FAQPage` on `/`, `BreadcrumbList` on inner pages.

## Quality gates for v1

WCAG 2.2 AA (keyboard, visible focus, contrast in both themes, reduced motion), no console errors, every route
200, OG images resolve, sitemap/robots correct, one `<h1>` per page, the hero readable with JavaScript off,
Lighthouse ≥ 95 (performance, accessibility, SEO), the skill's `verify.mjs` sweep (routes × breakpoints × themes).

## Responsive

The demo keeps working on phones: the mock page hides and the panel stays, with touch-and-hold on the button.
Sections stack into one column under 860 px.
