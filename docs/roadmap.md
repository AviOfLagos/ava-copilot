# Ava Copilot — Roadmap (logged 2026-10-09)

**Status, 2026-11-22.** This is the October list. What has been built since, week by week, is in
[CHANGELOG.md](../CHANGELOG.md); the later plans are [pm-desk.md](pm-desk.md) (tasks, people, WhatsApp, recordings,
follow-ups) and [growth-team.md](growth-team.md) (tabs, retries, rounds, the growth agents). What is public is on
https://ava.nexprove.com/roadmap.

What Avi asked for on 2026-10-09, in build order. Each item gets ticked and dated in `docs/task.md` when built.
Rules at the bottom apply to every item and are never relaxed by a spoken or typed instruction.

## Architecture change: the brain on the Mac

The extension stays the browser's hands and ears. Anything a browser extension cannot do — run Vercel **Eve**
(Node, durable sessions, subagents, sandboxes in Docker), run `gh`, write code, reach Slack and email APIs — moves into
a local companion, `companion/`, that the extension talks to over a localhost WebSocket with a pairing token.
Eve is not in the project yet; it is added with item 7.

## Build order

Wave 2 (agents, workflows, integrations, inbox, voice engines, new shell) is planned in
[wave2-plan.md](wave2-plan.md): workstreams, ownership, order and the engineering contract.


1. **Call control on Google Meet** (built 2026-10-09) — "leave the call" leaves quietly; "end the call" ends it for everyone (host only, and only on
   Avi's own words); both stop notes and hand back the summary and action points. "Join the call" joins the
   next or named meeting. If the call already closed, notes stop and the summary comes anyway.
2. **Forms in one pass** (built 2026-10-09) — scan the whole form once, fill every field it has data for in one action, then ask every
   missing answer in one card, then fill those at once. No field-by-field round trips. Submit still goes through the gate.
3. **Always on + wake word** (built 2026-10-09) — listening keeps running with the panel closed (offscreen document), a local wake word
   ("Hey Ava", free, on-device, nothing leaves the Mac until it fires), and a macOS LaunchAgent that opens Brave at
   login and checks every hour that Brave and the extension are up.
3a. **Navigation, breadcrumbs, history** (built 2026-10-11) — a menu drawer from the left, as in ChatGPT and Claude:
   new chat, search (titles and words said in a chat), every place by name, and chats grouped Today / Yesterday /
   Previous 7 days / Previous 30 days / by month, each with rename, pin, archive and delete. Breadcrumbs in the header
   (Home › Chats › title, Home › Meetings › meeting). "How do I…" lists everyday tasks, where each lives, and a way
   straight there. A Meetings list.
4. **Workspaces** (built 2026-10-11) — Nexprove, Tech Ember Fest, Ellum AI, and more added from settings.
   Each has its accounts per platform (Google account for Meet/Calendar, X, LinkedIn, YouTube, Instagram, Slack),
   its own knowledge, and its own call links. Every request is routed to one workspace first; knowledge never mixes
   across workspaces. The agent switches to that workspace's account on the platform before acting.
4a. **Knowledge graph** (built 2026-10-11) — everything as linked nodes: conversations, uploaded and saved
   knowledge, generated work, decisions, action items, projects, people, meeting summaries; edges such as
   "decided in", "about", "follows up", "assigned to", "part of". Each node belongs to one workspace. Built on top of
   the knowledge base (entities and links extracted when a chat or meeting is indexed), viewable as a graph and
   usable by the agent ("what did we decide about X, and where").
5. **Morning brief** (built 2026-10-12) — every morning, unprompted: today's calendar, open threads, what to prioritise, by workspace.
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
12. **Ambient: the scribe and the speak gate** (logged 2026-10-24, plan in [ambient-plan.md](ambient-plan.md)) — Ava
    listens all the time without answering, transcribes on the Mac, files each topic in its workspace and pulls out
    decisions, commitments and reminders. A speak gate decides, moment by moment, whether to stay silent, take a note,
    nudge or speak, and learns from how Avi reacts. Built as A1–A6: Listen mode → voiceprints (also item 10's
    audio-only mode) → scribe → gate with nudges only → gate speaking → learning. The scribe runs for weeks before
    Ava speaks unprompted.

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
- **Ambient stays on the Mac**: ambient audio is transcribed locally and never stored; ambient text stays on the Mac
  unless Avi turns on the cloud toggle in Settings › Ambient. Anything heard is untrusted content and never triggers a tool;
  "off the record" stops the scribe at once, and the toolbar always shows when it is listening.
