# Direction — Graphite glass, with the gate as the hero

## Studied

- **Direct competitors** (constraints, then set aside): Nanobrowser, Claude for Chrome, Perplexity Comet, ChatGPT
  Atlas, Gemini in Chrome, Dia, HARPA AI, Browser Use. Category default: dark gradient, centred hero, a fake browser
  screenshot, three feature cards, testimonials, pricing. Conventions kept: the install action above the fold, the
  product shown working, supported browsers and models listed, permissions and privacy stated, an FAQ.
- **Donors** (structural maps):
  - *Cockpit automation*: mode annunciation → the orb and run trail say what it is doing now; arm-then-engage →
    "Hold to send" is the engage.
  - *Maker–checker payments*: the agent drafts, you release; the audit trail → the run trail and run log.
  - *Privacy nutrition labels*: "What leaves your machine" as a label, not a policy wall.
- **Craft references**: Raycast (the product's real UI as the hero, keyboard hints, dark glass discipline);
  Ollama and Bun (the install one-liner is the primary CTA, with OS tabs); Granola (calm product states, plain
  human copy); Linear (type and spacing precision).
- **Unmet demand** (what users of AI browser agents complain about), turned into sections:
  1. "It did something I didn't ask" → the hero demo: it stops at an amber card until you hold the button.
  2. "Another subscription" → "Your model, your key — or fully local", with model chips and the free local voices.
  3. "I can't see what it's doing" → the run trail: every step as a node, raw steps one tap away.
  4. "Where does my data go?" → the privacy label; no analytics; keys stay in an encrypted local vault.
  5. "It's slow / gets stuck" → honest copy: it asks when it needs you; you can stop or take over at any step.

## Rejected pole

The AI-launch template: purple-to-blue mesh blobs, gradient headline text, three outline-icon cards, invented
testimonials and "10x" claims. Also neon sci-fi dashboards (already rejected for the app).

## DNA blend

≈50% Raycast (product UI as the hero, real widgets) · ≈30% Ollama/Bun (the one-liner install as the main action)
· ≈20% Granola (calm, human, states over illustrations).

## Art direction

**Signature move — the live gate.** A faithful side panel built from the app's own parts (composer pill, thinking
orb, run trail, confirm card) beside a mock web page. It runs a short task, the trail fills mint node by node, then
it stops at an amber diamond and a "Hold to send" button. Holding it (0.8 s, keyboard: hold Enter) sends; Stop sends
nothing. With JavaScript off, the page shows the paused state as static HTML.

**Supporting system.**
- Ground: graphite `#0C0E13`, one soft mint light from the top-left (~15%), global grain at ~3%. Light theme: frosted
  paper `#F3F4F7` with the same layers.
- Surfaces: the app's glass (white 3–7%, 18 px blur, 1 px border at 9%, 1 px top highlight). One light source: top.
- Colour has jobs: mint = acting, done, the primary action; **amber = waits for your click, nothing else** (the
  demo's commit, the "Held for you" figure); periwinkle = voice and meetings only.
- Imagery: no stock photos, no illustrations, no AI-generated art. Every visual is the real UI rendered with the
  app's CSS.
- Type: Geist Variable for text, Geist Mono for numbers, labels and commands. Display sizes at -0.035em.

## Tokens

The app's `src/ui/lib/theme.css` is the source (imported, not copied). Site additions: type scale
(display `clamp(40px, 6vw, 76px)`, h2 `clamp(28px, 3.6vw, 44px)`, body 17/28, mono labels 12–13 px uppercase
+0.06em), spacing on an 8 px rhythm, content width 1120 px, section rhythm `clamp(72px, 10vw, 140px)`.

## Themes

Dark (default), light, system; forced-colours keeps borders and focus rings.

## Interaction budget

Marketing tier: the gate demo is the one hero moment. Secondary graphics (the run-trail wire, the routine diagram's
wires, the voice orb) may animate once when they scroll into view. Headline copy never animates in. Reduced motion:
every state shown at once, no scroll effects. Durations 150–250 ms ease-out; the orb breathes at 4 s.

## Decided for you, say if wrong

Mood is the app's (you asked to reuse it). The product name stays **Avi Copilot** in one constant of the content
model, so a public rename is a one-line change.
