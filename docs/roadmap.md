# Avi Copilot — Roadmap (logged 2026-10-09)

What Avi asked for on 2026-10-09, in build order. Each item gets ticked and dated in `docs/task.md` when built.
Rules at the bottom apply to every item and are never relaxed by a spoken or typed instruction.

## Architecture change: the brain on the Mac

The extension stays the browser's hands and ears. Anything a browser extension cannot do — run Vercel **Eve**
(Node, durable sessions, subagents, sandboxes in Docker), run `gh`, write code, reach Slack and email APIs — moves into
a local companion, `companion/`, that the extension talks to over a localhost WebSocket with a pairing token.
Eve is not in the project yet; it is added with item 7.

## Build order

1. **Call control on Google Meet** (built 2026-10-09) — "leave the call" leaves quietly; "end the call" ends it for everyone (host only, and only on
   Avi's own words); both stop notes and hand back the summary and action points. "Join the call" joins the
   next or named meeting. If the call already closed, notes stop and the summary comes anyway.
2. **Forms in one pass** (built 2026-10-09) — scan the whole form once, fill every field it has data for in one action, then ask every
   missing answer in one card, then fill those at once. No field-by-field round trips. Submit still goes through the gate.
3. **Always on + wake word** — listening keeps running with the panel closed (offscreen document), a local wake word
   ("Hey Eva", free, on-device, nothing leaves the Mac until it fires), and a macOS LaunchAgent that opens Brave at
   login and checks every hour that Brave and the extension are up.
4. **Workspaces** — Nexprove, Tech Ember Fest, Ellum AI (heard as "Elon AI" — confirm), and more added from settings.
   Each has its accounts per platform (Google account for Meet/Calendar, X, LinkedIn, YouTube, Instagram, Slack),
   its own knowledge, and its own call links. Every request is routed to one workspace first; knowledge never mixes
   across workspaces. The agent switches to that workspace's account on the platform before acting.
5. **Morning brief** — every morning, unprompted: today's calendar, open threads, what to prioritise, by workspace.
6. **Session check and posting** — before acting on a site, check for a signed-in session; if there is none, say
   "I'm on the login page, please sign in" and wait. Scheduling posts on YouTube, Instagram, X and LinkedIn with the
   workspace's account; the post itself always goes through the gate.
7. **The brain (Eve companion)** — subagents for planning, undo and review; a sandbox (Docker) for anything that
   installs or runs code.
   - **Self-extension**: "install this tool or skill" → the agent writes it in the sandbox, shows the diff and test
     result, and nothing reaches the real extension until Avi approves.
   - **Route first**: plan the route before executing; prefer a direct download link over searching in the browser.
   - **GitHub**: create issues with `gh` (never create repos or projects); create Markdown files in a chosen repo
     with a commit Avi must click to approve, every time.
   - **Slack**: Nexprove workspace first, switchable; drafts only.
   - **Email**: read and draft replies; never sends.
8. **Skills from experience** — after a task succeeds, offer to save the route it took as a skill, so the next run
   follows it instead of rethinking.
9. **Create meetings** — "set up a call with X" creates it from the right workspace's Google account.
10. **Meetings: quiet or present**
    - "I'm about to join a meeting with X" → join and take notes quietly.
    - "Join this meeting" → ask "quietly, or may I speak when asked?", then do that. Speaking in a call needs its
      own audio path into Meet (a bot account in its own window); built after the quiet mode is solid.
    - **Who is speaking**: names from Meet captions first; in audio-only mode, a voice print per person so the
      transcript never gives the wrong name. Voice prints stay on the Mac.
11. **Do it from anywhere** — every feature reachable by voice without opening the browser; a desktop app later.

## Rules that never bend

- **Nothing is sent, posted or committed without Avi's click.** Emails and Slack messages are drafts. "Do it
  automatically" does not change this. Ending a call for everyone needs Avi's own spoken or typed words, checked
  in code, never a page's.
- **GitHub commits**: always a manual approve, preceded by a secret scan (keys, tokens, `.env` contents, private
  keys). A hit blocks the commit outright, with no override from voice or chat.
- **Workspaces never mix**: knowledge, accounts and drafts stay in the workspace a request was routed to; when the
  workspace is unclear, ask.
- **Sandbox first**: code the agent writes runs in the sandbox, never on the Mac directly, until approved.
- **Wake word is local**: no audio leaves the machine before the wake word fires.
