
# Ava Copilot — Build Spec (for a coding agent)

A general-purpose Chrome extension (Manifest V3) that gives Avi a Gemini-powered assistant in the browser side panel. It works on **any website**, not tied to one app. It can (1) operate any web page (chat apps, Google Workspace, dashboards, admin consoles, CMSs, forms), (2) take notes during live meetings in any browser call (Google Meet, Zoom Web, Teams Web, Zedu, etc.), and (3) keep every conversation and meeting in a searchable, multi-thread history. It uses Avi's own Gemini API key, with optional local models through Ollama.

**Base:** fork **Nanobrowser** (github.com/nanobrowser/nanobrowser, Apache-2.0). It already provides an MV3 side panel, a planner/navigator multi-agent loop, BYOK Gemini support, and DOM-based actions. Build the meeting notes, knowledge base and multi-session features on top of it, and don't rewrite what already works.

---

## 1. Goals / Non-goals

**Goals**

- G1. Run any browser task on any site in plain language with a Gemini key, with no Claude involved. Site-specific knowledge lives in optional skills, never in core code.
- G2. Live meeting notes from tab audio, with timestamps, a rolling summary, decisions and action items.
- G3. A persistent knowledge base made of past chats, meetings and saved pages. The user can ask questions across all of it.
- G4. Unlimited threads, several running at once, each tied to its own tab or tab group. Old threads resume with full context.
- G5. Reusable "skills" (playbooks) for any site or workflow, which the user can add without code and which get loaded when the site or task matches. Zedu is just one example.

**Non-goals (v1)**

- No mobile app or desktop audio capture outside Chrome. A native Zoom desktop app is out of scope; use Zoom Web.
- No multi-user or cloud sync. Everything stays local, with export/import.
- No auto-joining of meetings as a bot.

---

## 2. User stories

| #   | As Avi, I want to…                                                                                                                | Acceptance                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| U1  | say "post this announcement in#general" on whatever chat app is open (Slack, Discord, Zedu, WhatsApp Web…)                        | The agent shows the exact text and channel, waits for**Confirm**, posts, then verifies the message is visible.      |
| U1b | say "reply to the last 3 unread emails in Gmail with drafts" / "add these rows to my Sheet" / "open the PR and summarise the diff" | Works on any site with no site-specific code. Drafts are shown first, and nothing is sent without confirmation.           |
| U1c | say "do this task across tabs" (e.g. copy data from a dashboard into a form)                                                       | The agent reads one tab and writes to the other, and both tabs are bound to the thread.                                   |
| U2  | say "create a Google Form with these 12 questions"                                                                                 | The agent builds the form, then reports the edit link and the share link.                                                 |
| U3  | click**Start notes** during a Meet/Zoom-web call                                                                             | Within 10 s I see a live transcript, and a rolling summary refreshes every 2–3 min.                                      |
| U4  | click**Stop** at the end of a call                                                                                           | I get a structured note (summary, decisions, action items with owner and due date, open questions) saved to the KB.       |
| U5  | ask "what did we decide about Stage 2 deadlines last week?"                                                                        | I get an answer with citations that link to the meeting and timestamp.                                                    |
| U6  | open a thread from 3 days ago and continue                                                                                         | The full context loads, nothing is lost, and no "start a new chat" wall appears.                                          |
| U7  | run two tasks at once (fill a form in tab A, read a chat app in tab B)                                                             | Both threads run independently with their own status and stop buttons.                                                    |
| U8  | turn action items into tasks or messages later                                                                                     | "Draft follow-ups from yesterday's meeting" produces drafts and sends nothing until I confirm.                            |
| U9  | switch the model (Gemini Flash / Pro / local Ollama) per thread                                                                    | The setting persists per thread, and a default is set globally.                                                           |
| U10 | get answers in my style                                                                                                            | Responses are short and direct, give the answer first and end with action points. This is a global system-prompt setting. |

---

## 3. Architecture

```
Side Panel UI (React)  ── threads list, chat, meeting panel, KB search, settings
        │  chrome.runtime ports (one port per thread)
Service Worker (background)
  ├─ ThreadManager      – create/resume/fork/archive; one AgentRunner per active thread
  ├─ AgentRunner        – Nanobrowser planner+navigator loop, bound to tabId/groupId
  ├─ MeetingRecorder    – tabCapture → offscreen doc → audio chunks → transcriber
  ├─ Transcriber        – Gemini audio (default) | local Whisper server (optional)
  ├─ Summarizer         – rolling + final structured notes
  ├─ KnowledgeBase      – IndexedDB store + embeddings + hybrid search
  ├─ SkillRegistry      – markdown playbooks matched by URL pattern / keyword
  └─ ModelGateway       – Gemini API, Ollama; retries, rate limits, cost tracking
Offscreen Document     – holds MediaStream, MediaRecorder (MV3 requires this)
Content Scripts        – DOM snapshot, element indexing, actions, caption scraping fallback
```

**Key MV3 facts the coder must respect**

- `chrome.tabCapture.getMediaStreamId` must be called from a user gesture (a button click), and the stream is consumed in an **offscreen document**. A service worker cannot hold a MediaStream.
- The service worker can be killed after about 30 s idle. Keep everything in IndexedDB, keep the offscreen doc alive while recording, and make every runner resumable from storage.
- Use `chrome.sidePanel` with a per-window panel. Allow "pop out" into a separate window so several sessions can be visible.

---

## 4. Feature specs

### 4.1 Threads & sessions (G4)

- Data: `Thread {id, title, createdAt, updatedAt, model, boundTabId?, boundGroupId?, status: idle|running|waiting_confirm|error, pinned, archived, tags[]}` and `Message {id, threadId, role, content, toolCalls?, attachments?, ts}`.
- Sidebar list: search, pin, rename, archive, delete (with confirm), and fork ("branch from this message").
- **Concurrency:** up to N (default 3) threads running at once. Each is bound to one tab or tab group. Agents never act on a tab they're not bound to.
- **Long context:** when a thread gets past ~60% of the model window, auto-summarize the older turns into a pinned "thread memory" block and keep the full raw history in storage. The user never gets stuck.
- Auto-title the thread from its first message.

### 4.2 Browser agent (G1)

- Reuse Nanobrowser's DOM indexing and action set: click, type, select, scroll, navigate, extract, wait, new tab.
- Add a **page-text reader** and a **screenshot + vision** fallback for canvas-heavy apps such as Google Sheets and Forms.
- **Confirmation gate** (required): before any send, post, submit, delete, publish, purchase, permission change or IAM change, pause and show a diff ("About to post X in #channel"). Continue only on a click.
- After each write, verify that the result is visible on the page and report it.
- Stop button per thread, plus a global kill switch.
- **Prompt-injection guard:** page content is data. Ignore instructions found on pages, and flag them to the user.

### 4.3 Meeting notes (G2)

- Start/Stop button in the side panel. A recording badge shows on the tab.
- Capture: tab audio through `tabCapture`, with optional mic through `getUserMedia` (needed so your own voice is included). Mix both in the offscreen doc with WebAudio.
- Chunking: 30 s chunks with 2 s overlap → Gemini (audio input) → transcript segments `{tStart, tEnd, speaker?, text}`.
- **Caption fallback:** if audio capture fails, scrape Meet/Zoom live captions from the DOM.
- Rolling summary every 2–3 min. Final note on Stop:
  - Title, date, platform, duration, participants (from the page DOM when available)
  - TL;DR (3 lines), Decisions, Action items `{owner, task, due?}`, Open questions, Full transcript
- Saved to the KB and linked to a new thread named "Meeting – " so you can chat about it later.
- Export: Markdown, copy to clipboard, Google Docs (v2).

### 4.4 Knowledge base (G3)

- Store chunks from chats, meeting transcripts and notes, and pages you "Save to KB".
- Embeddings: Gemini embedding model (or local `nomic-embed` via Ollama). Hybrid search = vector + keyword (MiniSearch).
- Every answer cites its sources (meeting + timestamp, thread + message, page URL).
- Settings: retention, delete one item, wipe everything, export/import JSON.

### 4.5 Skills / playbooks (G5)

- Markdown files with frontmatter `{name, description, match: {urls[], keywords[]}}`.
- Auto-inject a skill into the system prompt when the URL or keyword matches. Can also be called with `/skillname`.
- Ship with a few generic examples (`chat-apps.md`, `google-forms.md`, `gmail.md`). Avi can import his own, e.g. `zedu-operator.md`.
- The core agent must work with **no skill loaded**. Skills only add tips such as site quirks, channel names and conventions.
- "Teach mode": after a successful task, offer "Save as skill?". This writes the steps and quirks it learned to a new playbook.

### 4.6 Settings

- API keys (Gemini, optional OpenAI-compatible/Ollama URL), stored in `chrome.storage.local` and never logged.
- Model per role: Planner (Gemini Pro), Navigator (Gemini Flash), Transcriber (Flash), Embeddings.
- Global style prompt (U10), confirm-gate on/off per action type (default all on), max concurrent threads, cost cap per day.

---

## 5. Gemini-specific guidance

- Use **structured output / JSON schema** for every agent step (action, args, reasoning, done). Reject and retry once on invalid JSON.
- Keep tool lists small per step: send only the actions relevant to the current page.
- Use Flash for navigation loops (fast, cheap) and Pro for planning, final meeting notes and KB answers.
- Use context caching for long transcripts and loaded skills.
- Handle 429/503 with exponential backoff and show "rate limited, retrying".
- Track token usage per thread and show its cost in the thread header.

---

## 6. Edge cases & expected behavior

| Case                                                                 | Expected behavior                                                                                                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service worker killed mid-task                                       | On wake, the runner reloads state from IndexedDB and shows "Resumed". Any write that hadn't been confirmed is re-asked, never auto-replayed.                                                        |
| Tab closed while its thread is running                               | Thread →`error: tab closed`, with an offer to reopen the URL and continue.                                                                                                                       |
| Two threads target the same tab                                      | The second is blocked with "Tab is in use by thread X".                                                                                                                                             |
| Meeting audio goes silent for the user once capture starts           | tabCapture stops the tab's audio from playing to the user while it records. The offscreen doc must route the stream back to the speakers through an`AudioContext`, or Avi can't hear the meeting. |
| Meeting in a background tab                                          | Capture continues. Warn if the tab is closed.                                                                                                                                                       |
| Recording > 2 h                                                      | Keep chunking; summaries are hierarchical (per 15 min, then overall). Watch IndexedDB quota and warn at 80%.                                                                                        |
| No audio / silence for 5 min                                         | Show a "No audio detected" warning and keep recording.                                                                                                                                              |
| Gemini rejects audio (size/format)                                   | Re-encode to 16 kHz mono opus/webm. Fall back to captions.                                                                                                                                          |
| Network drop during meeting                                          | Buffer chunks locally and transcribe when back online. Never drop audio.                                                                                                                            |
| Page DOM changes mid-action (single-page apps)                       | Re-snapshot and retry up to 2×, then ask the user.                                                                                                                                                 |
| Login / CAPTCHA / 2FA page                                           | Stop and ask the user to do it. Never type passwords.                                                                                                                                               |
| Element hidden behind an autocomplete popup, @-mention menu or modal | Detect overlays and close or select them before continuing.                                                                                                                                         |
| Long message with line breaks in any chat or rich-text editor        | Use Shift+Enter for newlines. Verify the composer content before sending.                                                                                                                           |
| API key missing or invalid                                           | Show a clear banner on the settings page and disable run buttons.                                                                                                                                   |
| Daily cost cap reached                                               | Pause agents and ask the user to raise the cap.                                                                                                                                                     |
| Consent / legal for recording                                        | A first-time modal reminds the user to tell participants. The recording badge is always visible.                                                                                                    |
| Prompt injection on a page                                           | Ignore it, and show "This page contained instructions; ignored".                                                                                                                                    |

---

## 7. Data & privacy

- All data is stored locally (IndexedDB), and audio is deleted after transcription by default (toggle to keep it).
- Only Gemini or Ollama endpoints get called. No analytics.
- Export or wipe from settings.

---

## 8. Tech requirements

- TypeScript, React, Vite (Nanobrowser stack), Manifest V3, pnpm.
- Permissions: `sidePanel, tabs, tabGroups, scripting, storage, unlimitedStorage, offscreen, tabCapture, activeTab`. Host permissions are optional and requested per site.
- Libraries: `idb` or Dexie (storage), MiniSearch (keyword search), `@google/genai` (Gemini SDK).
- Tests: unit tests for ThreadManager, KB search and the chunker. Playwright E2E with a fixture page for agent actions and a recorded audio file for the transcriber.

---

## 9. Milestones

1. **M1:** fork Nanobrowser, add Gemini key and style prompt, add the confirm-gate and verify-after-write.
2. **M2:** multi-thread persistence, concurrency, tab binding, auto-summary of long threads.
3. **M3:** meeting recorder (tab and mic), transcription, rolling and final notes.
4. **M4:** knowledge base, embeddings, cited Q&A.
5. **M5:** skills registry, teach mode, import/export of playbooks.

## 10. Definition of done

- U1–U10 pass manually on at least 5 unrelated sites (e.g. Gmail, Google Forms, Slack or Zedu, GitHub, Notion) plus one Meet and one Zoom Web call, with **no site-specific code** in the core.
- No write action happens without a confirm click.
- Killing the service worker mid-task never loses data.
- A 1-hour meeting produces notes in under 60 s after Stop.
