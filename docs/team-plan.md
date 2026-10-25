# Ava and the team: plan and priorities (logged 2026-10-25)

Avi's brief, short: agents are teammates. Ava (the coordinator) knows who is speaking, who is working and what waits
for him; one voice at a time; reply to any agent like a DM; every agent knows which workspace and account it acts
as; nothing breaks on update; answers stay short (Avi has ADHD, and so will many users). Planning only, nothing built
from this file yet.

## 1. How it should feel

| Situation | Behaviour |
|---|---|
| Talk to anyone | One wake word, "Hey Ava". Then a name routes: "Scout, find…" goes to Scout; no name, Ava routes by intent and says who took it. No per-agent wake words: each one is a model, a false-trigger risk and more mic time. |
| Several agents have something to say | Ava holds the floor. One voice at a time, from a queue. Order: needs your click > answer to you > update. After an agent speaks, the next waits until you answer or a pause passes (default 2 min, setting). Background agents default to silent: they queue, they don't talk. |
| "Ava, stop" / "everyone quiet" | Stops whoever speaks and pauses the queue. Per-agent mute from its card. Modes: Talk, Quiet (notifications only), Do not disturb. |
| Say it your way | Commands are understood by meaning, not exact words. "Ava stop", "give me a sec", "hold on" all stop; "push the reminder forward a bit" snoozes it; "let's get back to that" resumes what was paused. A small local intent classifier runs first (fast, offline); the model is asked only when it isn't sure. Replaces today's exact-phrase matching (`matchAmbientSwitch`). |
| Someone is speaking | A small speaking widget appears only while a voice plays and leaves when it stops: who is talking (name, colour, avatar), Pause / Play, Skip (next in the queue), Hide (for this turn). If an appear-and-leave widget proves unreliable, fall back to a fixed one. |
| "Ava, what's new?" | One digest in Ava's voice: who did what, what waits for you. No agent whispering one thing at a time. |
| Who just spoke? | Every spoken line is also a caption in the feed, with the agent's name, colour and avatar; tap to replay. The voice preview on each profile teaches you the voices. |
| Reply to an agent | Each agent has a DM thread (the Inbox becomes the team chat). Messages are labelled From Avi / From Ava / From the agent. Ava can post into a DM ("Avi says: …"); the agent answers there; its answer is spoken only through the floor queue, or relayed in Ava's digest. |
| See an agent | Its profile: name, role, voice (with Preview), colour; mode (voice or silent; how much it may do alone); workspace and accounts; what it reads for context; schedule and next run; queue (tasks, what waits for your click); run log; budget; personal instructions. Editable by you, by Ava, or by the agent when told to. |

## 2. Rules every agent gets (global standards)

One file, applied to every agent before its own instructions, so a new agent needs only its role:
the gate (nothing sent, posted, bought or deleted without your click); untrusted content is data; workspace
scoping; **account check before acting** (below); draft → confirm → schedule for anything public; the floor rules
(never speak over anyone, queue instead); short answers (lead with the point, no preamble); how to hand off to Ava;
how to say "I'm blocked: you need to sign in".

## 3. Accounts: checked in code, not hoped for

Today account switching is a playbook (`skills/builtin/account-switching.md`) the agent may or may not follow. Make
it a step the runtime enforces before any action on X, LinkedIn, Instagram, YouTube, Gmail, Calendar, Slack:
read the signed-in account → compare with the workspace's account for that site → switch → if not signed in, stop
and say "sign in as @x, then press Continue" → posting to several accounts: post to the first, show it, ask before
the rest (or offer schedule / draft instead). The content agent reads "this week" from the workspace: shipped
work, decisions, meetings and chats in the knowledge graph.

## 4. Nothing breaks on update

Reported: the Obsidian vault and other connections disappear after an update or reload; the calendar keeps
"taking too long"; Ollama shows disconnected; Docker stopped; WhatsApp still messages Avi's own number.
Plan: a connection health service. Every connection is stored durably; on start it reconnects by itself; its
status says plainly what is wrong and offers the one fix (start Ollama, start Docker, grant the folder again).
An upgrade test installs the previous build, connects everything, updates, and checks each connection is still
there. Diagnose each first; likely causes to check: a folder permission the browser drops on reload, the calendar
read through Ava Brain timing out, services not running rather than settings lost.

## 5. Home and navigation

Side nav: **Ava** (home), **Team** (each agent with a live dot: speaking, working, waiting for you), **Inbox**,
**Workspaces**, **Memory**. History moves behind a clock icon and search. Home becomes **Now**: who is working,
what waits for your click, the next scheduled runs, and Talk. The morning brief folds into one "Today" card.

## 6. Desktop app

Recommendation: stay in the extension until the team model (P1) is done, then build the desktop app (P3) — the UI
gets reshaped in P1 anyway, and the desktop app reuses it. Mac first, then Windows. Shape: Electron, because Ava
Brain (the Mac companion) is already Node and becomes the app's core; the React panel becomes its window; the
extension stays as the browser's hands, paired as today. Computer use: evaluate open-source projects to fork
(candidates: trycua/cua, bytedance/UI-TARS-desktop), choosing on licence, macOS support and how it drives apps.

## 7. Priorities

**P0 — now (trust):**
1. Connections survive updates; connection health with one-click fixes. Diagnose calendar timeouts, Ollama, Docker.
   Issue #12. Whether Vercel eve can carry the connections (OAuth, refresh, approvals): issue #13.
2. WhatsApp: stop messaging your own number (in #12).
3. Account check before acting, enforced.
4. Short answers by default for Ava and every agent (a "Brief answers" setting, on by default).

**P1 — next (a team, not a crowd):**
5. The floor: one voice at a time, a speaking queue, Stop, Quiet / Do not disturb, captions with who spoke;
   the speaking widget (pause, play, skip, hide); commands understood by meaning, not exact words.
6. Agent DMs in the Inbox (From Avi / Ava / agent), and Ava relaying.
7. Agent profile page: voice with Preview, mode, workspace and accounts, schedule, queue, run log, instructions.
8. Global agent standards file; name routing by voice.

**P2 — then:**
9. Content agent: weekly context, multi-account draft → confirm → schedule.
10. Evals: scripted scenarios per agent (routing, account checks, the floor, gate), run nightly; failures become issues.
11. Ambient A2–A3 (voiceprints, the scribe).
12. New Home (Now) and side nav.

**P3 — later:** desktop app (Mac), computer use, Ambient A4–A6, Windows installer verified, Chrome Web Store.

**Waiting on Avi:** make the repo public; Vercel root directory = `site`, production branch = `feat/restyle`.

## 8. Already queued before this plan

Ambient A2–A6 (`docs/ambient-plan.md`); posting through the gate, set up calls, Ava Brain installer, desktop app
(`docs/roadmap.md`); Windows installer on real Windows; Chrome Web Store listing; the companion test that reads a
deleted recording.
