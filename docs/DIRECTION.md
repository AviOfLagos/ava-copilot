# Nex Copilot — visual direction: Graphite glass

Mockups: https://claude.ai/artifact/KnRwLQkugxdVNsyuRGqyQC (home, a task as a run trail, voice, today, settings).

## The idea in one line

A dark graphite panel with frosted-glass layers, one mint accent for "the copilot is acting", and amber reserved for
"this waits for your click". Calm by default; colour means something.

## Rules

- **Ground:** graphite `#0C0E13`, one soft mint light top-left (a radial at about 15% strength), fine grain. Light theme:
  frosted paper `#F5F6F8` with the same layer rules. Dark, Light and System from the start.
- **Glass:** surfaces are white at 3–7% over the ground, `backdrop-filter: blur(18px)`, a 1px border at 9%, and a 1px
  inner highlight on the top edge. One light source (top), one shadow style.
- **Colour has jobs, not decoration:**
  - mint `#6EE7C8`: acting, done, the primary action;
  - amber `#F5B544`: held for confirmation; nothing else uses it;
  - periwinkle at 75%: meetings and calls only;
  - text `#E8EAF0`, secondary `#9097A6` (6:1 on the ground).
- **Type:** Geist for text and Geist Mono for numbers, labels and metadata. Both are OFL and bundled locally, because
  the extension makes no third-party calls. Display sizes use -0.03em tracking.
- **Buttons:**
  - primary: a mint glass pill with a lit edge and an inner highlight, plus a keyboard hint;
  - icon buttons: 32px glass squircles;
  - commits: **Hold to send**, a press-and-hold of 0.8 s that fills, or Enter held; the deliberate friction is the
    point;
  - nothing else is amber.
- **Signature move, the run trail** (borrowed from n8n's node graph): every task shows as a short vertical chain of
  nodes, so the user never reads a wall of step logs.
  - A node is one meaningful step: searched notes, opened Gmail, drafted.
  - The wire fills mint as steps finish.
  - A commit is an amber diamond that stops the chain until you click.
  - Raw steps stay one tap away.
- **Orb:** `orb-ui` (MIT; states idle, connecting, listening, thinking, speaking, error; fed by our own input and output
  levels).
  - Large in voice mode.
  - A 24px presence orb in the header shows what the copilot is doing in any view.
  - A CSS fallback when motion is reduced.
- **Conversation:**
  - your words in a soft right-aligned bubble;
  - the copilot's answer unboxed, set as text, with citation chips in mono;
  - the run trail between them;
  - the confirm card inline, not floating;
  - the composer is a floating glass dock with `/` for skills, add page, talk, and Go.
- **Metrics ("Today"):** only numbers the extension really has.
  - **Day strip:** 24 hour marks, coloured by tasks, held-for-you and calls.
  - **Steps you didn't take:** agent actions.
  - **Held for you:** sent versus stopped.
  - **Words caught:** in meetings.
  - **Cost per finished task**, against the daily cap.
  - **Remembered:** knowledge-base items, and how many answers cited them.
  - **Where the work happened:** by site.
- **Settings live in the panel:** model and key status, the "ask before it" chips, spending, then rows for Meetings,
  Memory, Skills, Blocked sites, How it writes, and Look. The options page stays as a full-window fallback.

## Rejected pole

Neon sci-fi dashboards (heavy glow, 3D, isometric). The energy-grid screenshot gives only its teal-on-graphite restraint
and the mono numerals.

## Motion

- Durations are 150–250 ms ease-out.
- The run-trail wire fills at each step.
- The orb breathes at 4 s.
- Everything respects `prefers-reduced-motion`.
