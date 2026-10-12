# Direction v2 — Ava gives the tour

v1 (graphite glass, the live gate as the hero) shipped and stays the base: the colour jobs, the glass, the type and
the "real widgets only" rule below are unchanged. v2 replaces v1's hero and section plan after the owner's review:
less text, the app's own widgets doing the explaining, the assistant's globe as the page's 3D object, and a narrated
tour.

## What the owner asked for

"Use less text, like nexmail; use widgets from the actual app; be expressive about the experience of our core
offerings, like figma-forge. Use the assistant's globe as a 3D asset, moving to give room for the text coming in at
every point. Have a pre-recorded read-out of each section, so as the user scrolls they hear each section. Show
integrations. Moodboards are for layout; our style guide (default dark, buttons, glass) stays. Add 3D assets in the
foreground and background."

## Studied (v2 additions)

- **nexmail** (product site): huge, short headlines ("Try to lose an email."), a numbered pill per section
  ("03 • Failover"), one supporting sentence, and a *working model* of the product in every section. Taken: the pill,
  the "Try to …" headline, one sentence, the working widget.
- **figma-forge** (product site): dotted-grid ground, two-tone headlines, live canvases, LIVE/SOON badges, capability
  tiles with tiny visuals, a stats strip of true numbers. Taken: the dotted ground (it echoes the dotted globe),
  two-tone headlines, badges, the stats strip.
- **Moodboards** (layout only): 8 — giant wordmark in the hero and again at the foot, bento cards mixing imagery and
  UI, inline image pills inside headlines, a dark list with a hover preview; 9 — wordmark, stat cards, numbered steps;
  10 — a dark glass card over a 3D shape; 11 — gradient glass panels framing the hero; 12 — fluted "glass effect
  light" panels.

## Rejected pole (unchanged)

The AI-launch template: purple-to-blue blobs, gradient body text, three outline-icon cards, invented testimonials,
"10x" claims. Also neon sci-fi dashboards. New for v2: decorative WebGL shapes that encode nothing. Our 3D object is
the assistant itself, and it does a job (it shows what state it is in, and it speaks).

## Signature move — Ava gives the tour

The assistant's globe — the app's own dotted orb (`src/side-panel/components/ui/dotted-orb.ts`, imported, never
edited) — is the page's 3D asset.

- **Big, fixed, gliding.** One canvas, `position: fixed`, moved with `transform` only, gliding (a damped spring,
  ~1 s) to a planned spot for each section. Every section is laid out around its spot: the headline sits on the
  other side, so text always has room. Wide widgets are glass or opaque cards in front of it; behind glass the globe
  shows frosted (moodboard 10).
- **It changes state with the section,** using the orb's own light programs: *listening* (a band sweeping, slow
  spin), *thinking* (two wandering lights, the panel's working state), *acting* (a chasing pulse), *done* (the dots
  sweep to mint), and *speaking* (the dots swell with the narration's level).
- **Static first frame.** The hero renders the globe as an SVG drawn at build time by the app's own drawing code (a
  recording 2D context), so it is there with JavaScript off and nothing pops in; the canvas takes over on the same
  frame.
- **Reduced motion:** the globe stays in the hero, still. **Phones:** smaller, one spot (the hero). **Hidden tab or
  nothing to show:** the drawing loop stops.

### The narrated tour

- A clear control in the hero: the globe plus **Listen to the tour** (with its length). Nothing plays before that
  click, and no audio file is requested before it.
- After the click, each section's line plays as the section reaches the middle of the screen: one at a time (a new
  section fades the last line out), a short settle delay so a fast scroll doesn't stutter, lines already heard don't
  repeat. The globe speaks to the audio's level (an `AnalyserNode`), and the line shows as a caption in a dock at the
  bottom, with Pause and Stop always visible. Hidden tab: paused, resumed on return. Esc stops it.
- Ava's voice is Kokoro `af_heart` (Apache-2.0), the app's default local voice, rendered **offline** by the app's
  own local TTS worker in headless Brave (`scripts/narrate.mjs`) and committed as small AAC files. No macOS system
  voices: their licence forbids commercial use.
- Lines are Ava's, first person, warm, one or two sentences (~6–12 s). The same text is in the HTML: the caption, and
  a "Read the tour" transcript, so search engines and screen readers get every word.

## Less text, more product

Each section is: a **numbered pill** (`01 • The gate`), a **2–6 word headline** (two-tone allowed), **at most one
sentence**, and a **working widget** built from the app's components. Prefer "Try to …" headlines that invite play.
The narration and the widgets carry the detail; the FAQ keeps the long answers (and the FAQ schema).

| # | Section | Headline | Widget (from the app) | Globe |
| --- | --- | --- | --- | --- |
| — | Hero | The AI copilot that waits for your click. | install command, tour button, giant wordmark | right, large, listening |
| 01 | The gate | Try to skip ◆ the click. | the live gate demo (run trail, thinking orb, hold button) | top right, acting |
| 02 | Every step | Watch it work. Take over. | the run trail filling, with Take over / Hand back; chats in their own tabs; sign-ins handed back | left, thinking |
| 03 | Voice | Just say ● "Hey Ava". | the voice orb, and the real composer with the dictation strip on a simulated level | left, listening |
| 04 | Memory | Ask what was decided. | a knowledge-graph corner you can hover, and a cited answer | right, thinking |
| 05 | Routines and agents | Runs alone. Still asks. | a routine diagram whose nodes light up in order; the Inbox card stack | left, acting |
| 06 | Models | Your model. Or fully local. | a model picker with local/cloud chips and where the words go | right, thinking |
| 07 | Integrations | Plugs into your tools. | connector and model marks (simple-icons, CC0), built-in vs by address | left, acting |
| — | Stats | — | true numbers only | — |
| 08 | Privacy | Try to find our server. | the privacy label | right, done |
| — | Hand it the work | What will you hand it? | dark list of tasks with a hover preview of each task's trail | sets behind the foot |
| — | Questions, close | Hand it the work. Keep the last click. | FAQ, install command, giant wordmark | low, done |

Integrations are stated as the code has them (`src/storage/lib/integrations/catalog.ts`): **built in** — GitHub,
Linear, Notion, Slack, Gmail, Google Calendar, Google Drive; **by address** — any MCP server, such as Buffer (API key)
or Figma's desktop server (`http://127.0.0.1:3845/mcp`; plain http is allowed only to this computer). Marks are
examples, not endorsements; a tool that writes asks first.

Stats are true numbers: 10 model providers built in (plus any OpenAI-compatible endpoint), 16 voices that run on your
computer (KittenTTS 8, Kokoro 8), 7 built-in connectors, 6 kinds of action that wait for your click, 0 analytics.

## Layout (from the moodboards)

- **Giant wordmark** "Avi Copilot" across the foot of the hero, the globe in front of it (moodboard 8's ball over
  "Granger"); again at the very bottom of the footer, cut at the baseline.
- **Bento grids** of rounded glass cards (radius 28) holding widgets, mixed sizes.
- **Inline image pills** inside headlines: the amber diamond, the voice orb's face, the mint pill.
- **A dark list** of tasks with a cursor-following preview (moodboard 8's events list); dark in both themes.
- **A stats strip** (figma-forge), mono labels over big numbers.
- **Header:** a floating glass pill (nexmail), sticky.

## Art direction — supporting system

- **Ground:** graphite `#0C0E13`, a fine dotted grid (24 px, fading toward the edges: the globe is dots, so is the
  ground), one soft mint light from the top left, grain at ~3.5%. Light theme: frosted paper `#F3F4F7`, the same
  layers, dots and grain inverted.
- **Fluted glass light** (moodboard 12), built in CSS: a soft coloured light behind vertical ribs (repeating
  gradients), a 1 px lit edge, `backdrop-filter` on the ones in front. Behind the globe in the hero (angled panes,
  moodboard 11), and in front of content at section edges with gentle parallax (CSS scroll-driven animations,
  compositor-only; static under reduced motion; only outside the text column, hidden on narrow screens).
- **3D glass objects,** rendered offline (three.js in headless Brave → WebP with alpha, `scripts/render-3d.mjs`;
  three.js never ships): an **amber glass diamond** (the commit point, only beside the gate), a **mint glass pill**
  (the composer), a **periwinkle glass ring** (voice). They float at section edges, one per section at most.
- **Surfaces:** the app's glass (white 3–7%, 18 px blur, 1 px border at 9%, 1 px top highlight). One light source:
  top. Cards radius 28, widgets inside keep the panel's radii.
- **Type:** Geist Variable; display 700 at −0.055em, line-height 0.94 (headlines are short now, so they can be big);
  Geist Mono for pills, numbers, labels and commands.

## Colour has jobs (unchanged)

- **Mint** — acting, done, the primary action.
- **Amber** — waits for your click, nothing else (the demo's commit, the diamond, an approval in the Inbox, a
  routine step that waits).
- **Periwinkle** — voice and meetings only.

## Tokens

The app's `src/ui/lib/theme.css` is the source (imported, not copied). Site additions: display
`clamp(44px, 7.4vw, 112px)`, section headline `clamp(40px, 6vw, 92px)`, wordmark `clamp(72px, 19.5vw, 300px)`, body
17/28, mono labels 12–13 px uppercase +0.06em; spacing on an 8 px rhythm; content width 1200 px; section rhythm
`clamp(96px, 12vw, 176px)`; card radius 28.

## Themes

Dark (default), light, system; forced-colours keeps borders and focus rings and drops the decoration.

## Interaction budget

Marketing tier. One signature moment (the globe and the tour); secondary graphics (trail, routine, graph) play once
when they come into view; headline copy never animates in; above the fold reads with JavaScript off. Response motion
150–250 ms ease-out; the globe's glide ~1 s (ambient); widget sequences ~4 s. Reduced motion: every state at once, no
parallax, the globe still in the hero, the tour still speaks.

## Budgets

LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1; initial JavaScript ≤ ~90 KB gzipped (the globe, the tour and the gate demo);
the voice island, audio and 3D images load on demand; everything readable with JavaScript off.

## Decided for you, say if wrong

Ava's voice is Kokoro `af_heart` (warm, American English; the app's default local voice). The tour is about a minute
and a half. Headlines are short enough that the FAQ keeps the long answers. The product name stays **Avi Copilot**
in one constant; the narration never says it, so a rename doesn't need new audio.
