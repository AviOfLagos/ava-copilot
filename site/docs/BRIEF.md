# Brief — the Nex Copilot website

**Product.** Nex Copilot is an AI copilot that lives in the browser's side panel (Brave, Chrome, Edge). It does
tasks on real pages, takes meeting notes, talks (with an on-device "Hey Ava" wake word and free local voices),
remembers what you saw, runs routines and helper agents, and works with any model (local Ollama or LM Studio,
OpenRouter, NVIDIA, OpenAI, Anthropic, Gemini). Its one rule: nothing is sent, posted, bought or deleted without
your click. It is a fork of Nanobrowser (Apache-2.0), with no analytics and no server of its own.

**Audience.** People who live in the browser and want to hand off work without handing over control: founders and
operators, developers, power users; privacy-minded; many bring their own model key or run models locally.

**Primary task on the site.** Copy the one-line install command and get it running. Secondary: understand what it
does and why it is safe to let it act.

**Trust posture.** Credibility, not excitement. An agent with access to your browser converts on trust: show the
gate working, say plainly what leaves the machine, show the lineage and the licence.

**Interaction budget.** Marketing tier (high): one substantial hero moment, secondary graphics may reveal once,
headline copy never animates in, and the page above the fold reads with JavaScript off.

**Constraints.**
- Static HTML for every indexable page; no third-party scripts, analytics, fonts or embeds (the product's own
  privacy stance applies to its site).
- Reuse the app's design language and real widgets (tokens in `src/ui/lib/theme.css`, the composer pill, orbs,
  dictation strip, confirm card, run trail). See `docs/DIRECTION.md` at the repo root for the app's rules.
- Light, dark and system themes; `prefers-reduced-motion` honoured everywhere; WCAG 2.2 AA.
- Budgets at p75: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1; hero island ≤ ~60 KB gzipped.

**Success.** In ten seconds a visitor can say what it is and why it is safe; the install command is copied; link
previews render; Lighthouse ≥ 95 for performance, accessibility and SEO on every route.

**Out of scope for v1.** Blog, docs site, pricing (it is free), accounts, analytics, a Chrome Web Store listing
(planned in `docs/distribution.md`), translations.
