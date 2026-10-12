# Avi Copilot — Build Plan

Companion to [spec.md](spec.md). Written 2026-10-02 after reading the spec and the Nanobrowser source at tag `v0.2.0` (released the same day).

The spec says what to build. This file says in what order, what the spec got wrong about the base, and the one design problem that has to be settled before any code.

---

## 1. Where the spec and the real upstream differ

Nanobrowser restructured its whole repo in v0.2.0. Several things the spec assumes are no longer true.

| Spec assumes | Upstream actually has | Decision |
| --- | --- | --- |
| Vite monorepo, `@google/genai` SDK | Single-package **WXT** app. All LLM calls go through the **Vercel AI SDK** (`ai` 7, `@ai-sdk/google`) | Keep the AI SDK. It already does Gemini structured output and audio input. Add `@google/genai` only if context caching turns out to be unreachable through it. |
| Permission list without `debugger` | Every page action runs through `puppeteer-core` over `chrome.debugger` | Keep `debugger`. Chrome shows its "is debugging this browser" bar on any tab the agent is bound to. Avoiding it means rewriting the action layer, which the spec forbids. |
| Host permissions optional, requested per site | `<all_urls>` | Keep `<all_urls>`. This is a sideloaded personal tool. Revisit only if it ever goes to the Web Store. |
| "No analytics" | Ships `posthog-js` and an analytics service wired into the executor | Remove in M0. |
| One AgentRunner per active thread | One global `currentExecutor` and one `currentPort` in `src/background/index.ts`. `src/background/task/manager.ts` is an empty file. | M2 is a real refactor of the background entry point, not an add-on. |
| IndexedDB storage | Chat history in `chrome.storage.local`, stored as one whole message array per session | Move to Dexie in M2. Fresh install, so no migration. |
| Confirm gate on "send, post, submit, delete…" | Actions are low-level: `click_element`, `input_text`, `send_keys`. No action knows it is a "send". | See section 3. |
| Runner resumes after the service worker dies | Pause/resume is an in-memory loop. It dies with the worker. | Persist step state in M2. |
| Ollama supported | Yes, through the OpenAI-compatible provider at `http://localhost:11434/v1` | Nothing to do. |

**Already there, reuse as is:** the planner + navigator loop, DOM indexing (`public/buildDomTree.js`), a guardrails service with prompt-injection patterns and a sanitizer, a speech-to-text service that already sends `audio/webm` to Gemini, an options page with provider and per-agent model settings, and a vitest setup.

---

## 2. Fork strategy

- Clone at tag `v0.2.0` into this folder. Keep `upstream` as a remote.
- Host it as a **private repo** `AviOfLagos/avi-copilot`, created as a normal repo and not a GitHub fork, because a fork of a public repo cannot be made private.
- Apache-2.0: keep `LICENSE`, add a `NOTICE` stating it is a modified version.
- Upstream is moving fast. New code goes in new directories (`src/background/threads`, `gate`, `meeting`, `kb`, `skills`). Edits to upstream files stay small, so later merges remain possible.

---

## 3. The confirm gate (settle before M1)

The definition of done says no write happens without a confirm click. The agent only knows "click element 14", so the gate cannot key on the action name. Two independent layers, and either one triggers the pause:

1. **Model-declared.** Add a required field to the navigator's structured output for every action: `effect: read | edit | commit`, plus `commitSummary`. `commit` pauses.
2. **Code backstop that does not trust the model.** Before running `click_element` or `send_keys`, inspect the target element. Pause if it is `type=submit`, or a button or link whose text or aria-label matches a commit word list (send, post, submit, delete, remove, publish, pay, buy, share, invite, grant…), or if the key is Enter while focus is in a form field or message composer.

Rules that follow:

- The confirm card shows the destination (page title, URL, channel) and the exact text **read back from the page**, not from the model's memory of what it typed.
- Gate state is persisted as `waiting_confirm`. After a worker restart it asks again and never replays.
- After a confirmed write, re-snapshot and check that the content is visible, then report.
- A false positive costs one click. A false negative breaks the definition of done. Tune toward asking too often.

---

## 4. Milestones

Each one ends in something usable. Sizes are relative: S, M, L.

### M0 — Fork and strip (S) — done 2026-10-02

- [x] Clone `v0.2.0`, rename to Avi Copilot, build
- [x] Remove PostHog and the analytics service
- [x] Gemini as the default provider: saving a Gemini key assigns `gemini-3.1-pro-preview` to the planner and `gemini-3.8-flash` to the navigator, for any agent that has no model yet
- [x] Ollama path confirmed: upstream already supports it through its OpenAI-compatible endpoint
- [x] Global style prompt setting (U10), injected into both agents
- [x] Missing key: the panel stays on its setup screen with no chat input. Invalid key: the key is checked against Google on save, flagged in settings, and no models are assigned, so the panel stays locked.
- [x] Run read-only tasks with a real Gemini key: done in Chrome for Testing on Wikipedia and Hacker News. The Hacker News answer (top 3 story titles) matched the page. Still to do by hand: load `dist/` in everyday Chrome.

**Exit:** a read-only task runs on an arbitrary site with only a Gemini key.

Notes for whoever continues:

- `gemini-3.1-pro-preview` is a preview model and the only Pro id Google lists today. It worked as the planner in the test run. If a key cannot call it, the planner is left unset and falls back to the navigator model.
- A key that goes bad after setup is only caught at run time ("Task failed: API key not valid"). Upstream behaviour, left as is.
- The repo URL in `package.json`, the READMEs, the Help tab link and the OpenRouter referer header still point at Nanobrowser.

### M1 — Safe agent (L) — built 2026-10-02, exit criterion not yet met

- [x] Confirm gate, both layers, with a toggle per kind (send, publish, submit, delete, purchase, permission)
- [x] Verify-after-write: the page is read before and after a commit and the result is reported
- [x] Guardrails result shown in the panel ("This page contained instructions; ignored.")
- [x] Sign-in, CAPTCHA and one-time-code steps are handed to the user. Password fields are never typed into.
- [x] `read_page_text` action, and a screenshot sent automatically when the page is drawn on canvas
- [x] Overlays: upstream already lists only the top layer and re-reads the page when new elements appear, so a covered control cannot be clicked. Added a test and prompt guidance, no new code.
- [x] Line breaks in rich-text editors are typed as Shift+Enter. Before this, a multi-line message sent its first line as soon as it was typed, with no confirmation.
- [x] 429/5xx backoff with a visible "Rate limited, retrying" line, tokens and cost per chat in the header, daily cost cap (default $5)
- [x] E2E suite: 17 tests in `e2e/`, run with `pnpm test:e2e`
- [ ] Run U1, U1b and U2 on 5 real sites (Gmail, Google Forms, Slack or Zedu, GitHub, Notion)

**Exit:** U1, U1b, U2 pass on 5 unrelated sites.

How the gate works, for whoever continues:

- Code lives in `src/background/gate/`. `classify.ts` is the deterministic layer and has the word lists. `review.ts` is the flow. `probes.ts` holds the functions that run inside the page.
- The gate runs inside the `click_element`, `input_text` and `send_keys` handlers, on the same element the handler is about to use. Replayed history goes through the same handlers, so it is gated too.
- After the user confirms, the content and the control are read again. If either changed while the card was up, nothing runs.
- A refusal stops the task, so the agent cannot look for another way to do the same thing.
- The E2E tests use puppeteer-core (already a dependency) and a scripted OpenAI-compatible mock model, not Playwright and not Gemini. They need Chrome for Testing; set `CHROME_PATH` if it is not in the Playwright cache.

Known gaps:

- A pending confirmation is held in memory. If the service worker dies while the card is up, the task is lost and nothing runs. Persisting it is M2.
- Not gated unless the model declares `commits`: `go_to_url` to a link that acts on GET, `select_dropdown_option` on a form that submits on change, and keyboard shortcuts other than Enter, Space, Delete and Backspace.
- The word lists are English only.
- The new strings are English in all three locales; `pt_BR` and `zh_TW` are not translated.
- Prices in `src/background/usage/pricing.ts` were read from Google's pricing page on 2026-10-02 and need updating by hand. A model without a price is counted in tokens only and never trips the cap.
- The canvas screenshot fallback is tested on the fixture, not on Google Sheets.

### M2 — Threads (L) — built 2026-10-03

- [x] Dexie database `avi-copilot`: threads, messages, and empty tables for meetings, transcript segments and the knowledge base
- [x] ThreadManager in `src/background/threads/manager.ts`: one executor and browser context per running thread, each bound to its own tabs
- [x] Tab binding: the active tab, or the whole tab group, or the highlighted tabs. Tabs the agent opens join the thread and are grouped. Other tabs are hidden from the model and refused.
- [x] "Tab is in use by thread X" lock, tab-closed error with "Reopen and continue", debugger bar closed stops only that thread
- [x] Service worker restart: a run interrupted less than 10 minutes ago resumes on its tabs with a "Resumed." message; an older one is marked interrupted with a Continue button. A pending confirmation is asked again, never replayed.
- [x] Concurrency cap, default 3, in settings
- [x] Thread list: search, pin, rename, archive, delete with confirm. Branch from any message.
- [x] Auto-title from the first message. Thread memory: past ~12k tokens the older turns are summarized into the thread. Inside a running task, past 60% of the input budget the older steps are summarized.
- [x] Model per thread (or the default agent models)
- [x] Pop-out window per thread, and a "Stop all" switch
- [x] Tests: thread store and ThreadManager unit tests; 7 E2E tests in `e2e/threads.e2e.mjs`

**Exit:** U1c, U6, U7, U9 pass. Killing the worker mid-task loses nothing. U6, U7 and the worker kill are covered by E2E tests; a real Gemini follow-up after a worker restart answered from the stored history. U1c (read one tab, write another) is not tested yet.

How it works, for whoever continues:

- The background owns the record. Every agent event becomes a thread message, an activity line or a pending request in the database (`src/background/threads/transcript.ts`), so the panel is only a view and can close, reopen or pop out at any time.
- A finished run's executor is kept in memory (up to 5) so a follow-up keeps the model's full history. After a restart, or for an older thread, a new executor starts with the thread transcript as context, framed as history the agent must not act on.
- Fixed while testing: Chrome keeps a restarted worker's debugger session on the tab, so the resumed run could not attach. `Page.attachPuppeteer` now detaches the stale session, which belongs to this extension, and retries.

Changed from upstream:

- Closing the panel no longer stops the task. Runs keep going and the record is kept; stop them from the panel or with Chrome's debugging bar.
- The chat history store and replay (`/replay`) are no longer used by the panel, and the debug commands `/state` and `/nohighlight` are gone.
- `tabGroups` permission added.

Known gaps:

- Navigating a thread's tab activates it, so two threads in the same window take turns being the visible tab.
- Runs resume only within 10 minutes of the interruption, by design.
- Thread messages are kept forever; retention and export come with M4.

### M3 — Meeting notes (L) — built 2026-10-03

- [x] Offscreen recorder (`src/offscreen`): tab audio played back to the speakers, optional mic mixed in, 16 kHz mono PCM through an AudioWorklet
- [x] Chunks of 30 s with 2 s overlap (the first is 8 s, so words show quickly), written as WAV straight into IndexedDB before anything else happens: a network drop or a worker restart loses nothing
- [x] Transcriber: the speech-to-text model setting, else Gemini Flash. Sentences that cross a chunk boundary are stitched, so none is repeated or cut.
- [x] Rolling summary every 2.5 min; 15-minute block summaries for long meetings; structured final note (title, TL;DR, decisions, action items with owner and due date, open questions, participants) from the Pro model
- [x] Note saved with the meeting and posted to a "Meeting – …" thread, so it can be asked about
- [x] Caption fallback for Meet, Zoom web and Teams when the tab cannot be recorded
- [x] First-run reminder to tell participants, REC badge on the tab, silence warning after 5 min, storage warning at 80%, daily cost cap holds transcription with the audio kept
- [x] Export: copy Markdown, download .md
- [x] Tests: chunker, WAV, stitching and note unit tests; 5 E2E tests in `e2e/meeting.e2e.mjs` (including a worker restart mid-recording); a manual real-speech check in `e2e/manual/meeting-gemini.mjs`

**Exit:** U3 and U4 pass with the scripted model, and with real speech through Gemini (a `say` recording: accurate transcript, correct decision, owner, due date and open question). The first words show in under 10 s. A 1-hour meeting is transcribed as it goes, so Stop leaves one chunk and one note call; the 60-second target is not measured on a real hour.

How it works, for whoever continues:

- Chrome records a tab only after the extension is invoked on it. The toolbar button therefore opens the panel from `action.onClicked` (not `openPanelOnActionClick`): that click is the invocation. Alt+Shift+M also works. A tab that was not invoked falls back to its captions, or the panel explains what to click.
- The recorder lives in the offscreen document and survives the service worker. On restart the manager asks it whether it is still recording and carries on.
- E2E can press the toolbar button through CDP (`Extensions.triggerAction`, needs a pipe and `--enable-unsafe-extension-debugging`). Fake media flags break tab capture, and headless tabs capture silence.

Live captions and questions (added 2026-10-03):

- Live captions come from the Gemini Live API (`gemini-3.8-live`, `src/offscreen/live.ts`), streamed the same 16 kHz audio. Its models only reply with audio, so the reply is capped at one output token: tested against the real API, that stops the reply while the input transcript still arrives, a whole remark about a second after the speaker pauses. Billed at $0.005 a minute, counted toward the daily cap. Sessions reconnect with a resumption handle. On by default when a Gemini key is set.
- The chunked transcript stays the record: Live is not used as the transcriber, because its transcript comes per remark, it does not label speakers reliably, and a dropped connection would lose words.
- Ask about a meeting while it runs or after: answered by Flash from the summary, the transcript and captions newer than the transcript, with times quoted. Questions and answers are kept in the meeting's thread.
- "Refresh now" on the summary, and the refresh interval in settings.
- One run of the full suite had the live-captions test fail under load; six runs since passed. Watch it.

Known gaps:

- Speaker labels are per clip, so the same voice can be "Speaker 1" in one chunk and named in the next.
- The model can occasionally add a word at the end of a clip that was not said.
- The microphone path is not covered by automated tests (headless Chrome has no microphone).
- ~~"Saved to the knowledge base" waits for M4~~: done in M4. A finished meeting's note and transcript join the knowledge base.

### Voice — talk to the copilot (added 2026-10-03, not in the spec)

- [x] Talk button in the panel: a spoken conversation over the Gemini Live API (`gemini-3.8-live`), held in the offscreen document so it survives the panel closing. Mic in at 16 kHz, the copilot's voice out at 24 kHz; talking over it stops it.
- [x] Tools: `run_browser_task` (starts a thread on the tab you are on), `ask_meeting`, `get_status`, `stop_tasks`. None can approve anything.
- [x] Proactive: the copilot says when a task it knows about finishes, fails, or waits for your Confirm click, and when meeting notes are ready.
- [x] Any thread waiting for a click shows its Confirm card at the top of the panel, whatever you are looking at.
- [x] The conversation is kept in a "Voice conversation" thread. Billed by the minute ($0.005 in, $0.018 out) against the daily cap.
- [x] Tests: notice and audio unit tests; 2 E2E tests with a fake microphone and the mock's Live API (a spoken task, and a send that waits for the click)

Checked against the real API (a probe script, not a test): it hears speech, answers aloud, calls `run_browser_task` with a sensible task, and passes on a notice. Not yet tried with a real microphone and speakers.

Rules kept on purpose: it speaks to you, never into a call; a spoken "yes" never confirms, only the click does.

### M4 — Knowledge base (M) — built 2026-10-03

- [x] Chunk and embed chats, meetings and saved pages (`src/background/kb`). Chats keep only what the user asked and what the copilot answered, about 1,600 characters a chunk; meetings are the note plus transcript windows of up to two minutes, each anchored at its start time; pages are overlapping chunks.
- [x] Embeddings: `gemini-embedding-2` at 768 dimensions with the Gemini key ($0.20 per million tokens, counted toward the daily cap under the "knowledge-base" session). It takes no task type, so queries are prefixed `task: search result | query:` and documents `title: … | text:`. Without a Gemini key everything still works by keyword.
- [x] Vectors in IndexedDB (Dexie v3 `kbItems`, `kbChunks`), brute-force dot product in memory, plus MiniSearch (fuzzy, prefix) for keywords, fused by reciprocal rank. At most three passages per source. Plain time phrases ("yesterday", "last week", "on Tuesday", "past 3 days") raise sources from that time; they never hide others.
- [x] Re-indexing a chat keeps the embedding of every chunk whose text did not change, so only new turns are paid for.
- [x] Cited answers from the planner model: the panel's Knowledge view (book icon) shows the answer with numbered chips and a source list. A meeting citation opens the meeting with that transcript line highlighted; a chat citation opens the chat; a page citation opens the page.
- [x] Added on their own: a chat when its run settles, a meeting when its note is written (a sweep on start-up catches anything missed). "Save this page" in the Knowledge view.
- [x] The agent has a read-only `search_knowledge` action and both prompts know about it, so "Draft follow-ups from yesterday's meeting" searches the notes first; sending still goes through the gate. Voice has `ask_knowledge`.
- [x] Settings → General → Knowledge base: add chats, add meetings, keep for (forever, 30 to 365 days), export JSON, import JSON (validated), wipe. Deleting a chat removes it from the knowledge base. Wipe and retention never touch the chats and meetings themselves.
- [x] Tests: 43 unit tests (chunker, search and time phrases, citations, import validation, the manager on a real IndexedDB); 4 E2E tests (`e2e/kb.e2e.mjs`: a meeting cited at 12:04 and opened at that line, a chat added when its task ends, a saved page found by the agent and removed, export/wipe/import). The mock serves Gemini's `batchEmbedContents`.

**Exit:** U5 passes against the mock (question with "last week" → answer citing the meeting and timestamp, click opens the line). U8: the parts are in place (search_knowledge finds the action items; drafting and the gate already work) but not yet run end to end on a real Gmail with a real meeting.

Known gaps:

- A chat citation opens the chat, not the exact message.
- Checked against the real `gemini-embedding-2` (a probe, not a test): 768-dimension unit vectors, and a Stage 2 question ranks the Stage 2 note first. The API reports no token count, so cost is estimated at four characters a token.
- A very large knowledge base (tens of thousands of chunks) loads every vector into memory per search after a change. Fine at personal scale.
- Locales other than English still carry English text, like the rest of the fork.

### M5 — Skills (M) — built 2026-10-04

- [x] Skills are Markdown files with frontmatter `name`, `description`, `match: {urls, keywords}` (`urls`/`keywords` may also be top level; a file with no frontmatter takes its file name). The parser reads only the YAML subset skills need: no new dependency. `src/storage/lib/skills`.
- [x] Registry in `chrome.storage.local`: the user's skills plus three built-ins (`gmail`, `google-forms`, `chat-apps`, shipped as `.md` files). A user skill with a built-in's name replaces it; deleting it brings the built-in back. Built-ins can be turned off.
- [x] Matching (`src/background/skills/match.ts`): `/name` anywhere in the task, then URL patterns against the current page (`*` globs; a bare domain covers its subdomains; `*.x.com` also covers `x.com`), then whole-word keywords in the task. At most three skills, 8,000 characters between them.
- [x] Loaded per step into the browser-state message, so a task that moves to another site picks up that site's skill. The thread says "Using skill /name" the first time. The section restates that commits still wait for confirmation, and the gate does not read skills at all.
- [x] Settings → Skills: import `.md` files (several at once), write a new one, edit (a built-in edited becomes your own), turn on or off, export `.md`, delete.
- [x] Teach mode: after a browsing task that finished without error, the chat offers "Save as skill?". The chat's model drafts name, description, URL patterns, keywords and tips from the task log (no passwords or message contents); you review and edit the Markdown before it is saved. Asked once per chat.
- [x] Tests: 23 unit tests (frontmatter, parse and write back, store, URL globs, keywords, `/name`, ranking, limits, teach transcript and draft); 4 E2E tests (`e2e/skills.e2e.mjs`).

**Exit:** passes with a stand-in. `e2e/zedu-operator.md` (the fixture page plays Zedu) imports through the settings page and loads on its site with no core change. Avi's real `zedu-operator.md` was not on this machine; import it under Settings → Skills and check its `match.urls` cover Zedu's domain.

Known gaps:

- No `/` autocomplete in the chat box yet; type the name.
- A skill is matched against the task and the current page only, not against pages the planner intends to visit.

### Restyle — Graphite glass (added 2026-10-09, not in the spec)

Direction: `docs/DIRECTION.md`; mockups: https://claude.ai/artifact/KnRwLQkugxdVNsyuRGqyQC.

- [x] Tokens in `src/side-panel/index.css`, named like Tailwind 4 (`--color-*`) so ported components read them unchanged. Dark by default, plus Light and System (Settings → Look). Geist and Geist Mono are bundled locally. `tailwindcss-animate` is added.
- [x] Colour jobs: mint is acting, done and the main action. Amber is only "waits for your click". Periwinkle is calls.
- [x] Components:
  - **From the user's MorphOrb:** the composer pill (glass, aurora, lit ring, spark, a send button that lights up) and the full MorphOrb in Memory → Ask. The pill launches into a dotted orb that cycles "Searching / Reading / Weighing / Writing", then unfolds into the answer, with sources underneath. It measures its own box instead of the window, and its card grows to fit. Its `.mo-*` styles were missing from the paste and were written to its CSS-variable contract.
  - **The dotted orb, split out:** `ui/dotted-orb.ts` and the inline `ThinkingOrb`, shown while a run works and in the header while anything runs.
  - **From the user's LiveOrb:** the WebGL orb with eyes in the header (idle), home, welcome and voice. The paste stopped mid-file; its render loop, gaze, blink and React wrapper were written here.
  - **Ported from AI Elements (Vercel, Apache 2.0):** Conversation (stick to bottom), Message (Streamdown markdown, no plugins), Chain of Thought, Shimmer and Suggestion. Chain of Thought becomes the **run trail**: n8n-style nodes on a wire, with a "held" amber diamond and a failed state.
- [x] Views:
  - **Header:** presence orb, title, Memory, Notes, Talk, New and Settings.
  - **Home:** LiveOrb and a greeting. Suggestions fit the tab you're on: its skill, summarize, memory, and notes on meeting sites or save the page elsewhere. Also a Today strip and saved prompts.
  - **Chat:** turns of request → run trail → answer (`chat/turns.ts`). The newest run stays open.
  - **Confirm card:** Hold to confirm (0.8 s) or click twice.
  - **Thread bar:** chips for the tab, the model, cost and pop-out.
  - **Memory:** Ask and Saved tabs.
  - **Today:** numbers the extension really records (day strip, steps you didn't take, held for you sent/stopped, words caught, cost per finished task, finished tasks, sites).
  - **Voice:** a full-panel LiveOrb with the transcript, End and Hide.
  - **Settings in the panel:** model status, the "ask before it" chips, the daily cap, how it writes, meeting and memory switches, skills on/off, and Look. Full settings stay one tap away.
- [x] The gate's "Confirmed / Cancelled" note is now a `system` message, so it shows as a step of the run instead of a new request.
- [x] Voice: a start that fails, such as one with no Gemini key, now answers the panel, so Talk never stays on "Connecting".
- [x] Tests: `chat/turns.ts` and `today/today.ts` have unit tests. The E2E harness confirms with two clicks and finds icon buttons by name. `e2e/manual/screens.mjs` saves screenshots of every screen.

Known gaps:

- Not yet tried in Brave, whose own sidebar may not show Chrome's extension side panel; the pop-out window is the fallback.
- `ChatInput.tsx`, `MessageList.tsx` and `SidePanel.css` are no longer used; they are kept until removing them is agreed.
- The options page keeps its old look; the panel's settings cover the everyday ones.

### Browser reach, local models, quieter pages (added 2026-10-09)

- [x] Voice can see the browser: `list_tabs`, `read_page` (the page in front or a given tab, as untrusted text, first 6,000 characters), `open_tab` (an address or a search; the blocked-sites list applies) and `switch_tab`. These navigate and read; they never commit. `src/background/voice/browser-tools.ts`.
- [x] The agent sees every free web tab, not only the ones bound to its chat, and can switch to and take over any tab no other running chat holds. A tab held by another chat stays refused.
- [x] Highlights (numbered boxes over the page) are off by default and switched off once for existing installs. Settings → Agent → "Show what it clicks" brings them back. Vision mode still shows them, because it needs them.
- [x] Local models:
  - The agents already run on Ollama: add an Ollama provider in full settings, then pick its model for Planner and Navigator.
  - Memory search can now embed locally with Ollama's `nomic-embed-text` (Settings → Memory → "Search by meaning with"). On "auto" it uses Gemini when there is a key and Ollama otherwise.
  - Voice, live captions and meeting transcription stay on Gemini: no local model takes live audio in this setup.

Not yet tried with a real Ollama server on this machine (none installed); the choice between sources is unit-tested.

---

### Roadmap from 2026-10-09

The next stretch of work (call control, one-pass forms, wake word, workspaces, the Eve companion and more) is logged
in order in [roadmap.md](roadmap.md), with the rules that never bend.

- **Call control (built 2026-10-09)**: voice tools `leave_call` and `end_call_for_everyone` (Google Meet,
  `src/background/meetings/call-control.ts`). Leaving always picks "just leave"; ending never falls back to leaving,
  needs the user's own words (`spokeEnd`), and clicks nothing when the user is not the host. Both stop the notes and
  read back the summary. `join_next_meeting` now presses Join on Meet.

- **Forms in one pass (built 2026-10-09)**: agent action `fill_form` (`src/background/forms/fill.ts`). Every field
  passes `reviewAction` before any is filled, then all are filled with the indices the model saw, then every open
  question goes to the user in one card (`ConfirmRequest.kind = 'questions'`, answers via `ConfirmGate.takeReplies`).
  It never submits; the submit click still goes through the gate.

- **"Hey Ava" and always on (built 2026-10-09)**: an on-device Vosk recogniser with a one-phrase grammar
  (`src/offscreen/wake.ts`) in the offscreen document, kept running by `src/background/voice/wake.ts` (setting
  `meetingSettings.wakeWord`, off by default; a `wake-check` alarm every minute; `runtime.onStartup`). Hearing it plays
  a chime and starts a voice conversation with the last 3 s of audio sent first, so "Hey Ava, what's on my calendar"
  works in one breath; a wake-started conversation ends after 2 minutes of quiet with no task running. Files come from
  `node scripts/wake-word-setup.mjs` (git-ignored `public/wake/`, pinned SHA-256s, the worker made eval-free); the
  manifest allows `'wasm-unsafe-eval'` for it. `scripts/always-on/install.sh` adds a login item that opens Brave at
  login and hourly if it is not running. E2E: `e2e/wake.e2e.mjs` (needs the setup; a recording as the microphone).
  Only the phrase (the last 1.2 s) and what follows it reach Gemini, never earlier audio. A conversation the wake word
  started while a tab was playing sound, or with sound since (`voice/sound.ts`, last 15 s, fails closed), asks for a
  click on a notification before every tool but `stop_tasks` (`UNGUARDED_TOOLS`, deny by default; `voice/confirm.ts`; fixed wording,
  one refusal refuses the rest of the conversation), and ending a call for everyone always does. Residual risk: sound from
  outside the browser (another app, a TV) saying "Hey Ava" is not detected; echo cancellation and headphones help.

- **Navigation and history (built 2026-10-11)**: `layout/Sidebar.tsx` (menu drawer: places, search, chats by date
  from `threads/history.ts`), `layout/Breadcrumbs.tsx`, `help/HelpView.tsx` ("How do I…", strings `help_<id>_q/where`),
  `meetings/MeetingsList.tsx`. The panel has one `place` (`chat | today | meetings | memory | settings | help`) in
  place of four show flags. Thread search also matches message text. Knowledge base and Settings left the header for
  the menu. Screens: `node e2e/manual/nav.mjs <dir>`.

- **Workspaces (built 2026-10-11)**: `src/storage/lib/workspaces` (name, about, keywords, accounts per platform;
  Nexprove, Tech Ember Fest and Ellum AI seeded once; `routeWorkspace` picks one only when exactly one matches;
  `workspaceForAccount` by Google address or company domain). A new chat goes to the workspace picked on Home or named
  in its words (`ThreadManager.placeInWorkspace`, with a note in the chat); the chip in the thread bar moves it. The agent
  gets `[Workspace: …]` with its context and accounts every step (`background/workspaces/inject.ts`) and the built-in
  `account-switching` skill. Knowledge items carry the workspace of their chat or meeting; a search in a workspace sees
  its own and unassigned items only (`KbIndex.search({ workspaceId })`, agent actions, Knowledge base filter). A meeting
  takes the workspace the topic the user typed names (first, and it overrides an earlier choice: one company's
  call link serves many workspaces), else the Google account in Meet's own account button (read only while the tab is
  on Meet); never an invite's or a page's title. Settings › Workspaces edits them.

- **Knowledge graph (built 2026-10-11)**: Dexie v4 `graphNodes` / `graphEdges` (`src/storage/lib/graph`). Every
  knowledge item is a node; `GraphBuilder` (`src/background/graph/builder.ts`) follows `KnowledgeBase.onChange` and
  reads each new or changed item once (hash of what was read) with the navigator model for people, organizations,
  projects, decisions and actions (`extract.ts`, the item wrapped as untrusted); meeting notes add their participants,
  decisions and action items without a model call. Entities are keyed by type, workspace and name, so a project named in
  two chats of one workspace is one node and never merges across workspaces; a node no source mentions any more is
  removed. Setting `kbSettings.buildGraph` (Settings › Memory). Knowledge base › Graph: a force-laid map, type filters,
  the node in focus with its links grouped by kind, a trail, search and "most connected". Agent action `look_up_graph`
  (scoped to the task's workspace). Screens: `node e2e/manual/graph.mjs <dir>`.

- **Obsidian (built 2026-10-11)**: `src/side-panel/vault` (Settings › Obsidian). The user picks the vault folder (File
  System Access; the handle is kept in IndexedDB `avi-vault`; Brave may ask again after a restart). Sync runs in the
  panel on opening and every 10 minutes: the knowledge base and graph are written into `Avi Copilot/<workspace>/`
  (Chats, Meetings, Pages, Notes, People, Projects, Organizations) as notes with full-path `[[links]]` and a
  `source: avi-copilot` line; only changed files are written, a file without that line is never overwritten or removed.
  The user's own notes outside that folder join the knowledge base as `note` items with source id `vault:<path>` (top
  folder or a `workspace:` line picks the workspace), refreshed when changed and removed when deleted, with no graph
  model call each. Background accepts them only from extension pages (`kb_vault_import`, `kb_vault_remove`).
  Everything written from outside sources is made inert for Obsidian first by escaping, not by looking for patterns
  (`defang`: backslashes, then every backtick and tilde, every "!" before "[", "&" and "<"; script and `obsidian:` links
  cut), so no code block, inline query, Templater tag, HTML, image or embed can form.

- **Morning brief (built 2026-10-12)**: `src/background/brief` (`MorningBrief`, alarm `morning-brief` every 15
  minutes, first check a minute after start; `briefSettingsStore`: on by default at 08:00). Once a day it saves a chat
  tagged `brief`: up to three priorities (the only model call, with the data wrapped as untrusted), today's calendar,
  chats waiting on the user or stopped, and each workspace's actions of the last 7 days and decisions of the last 3
  from the graph. Every line from a source is flattened and stripped of Markdown that links or loads. The notification
  carries counts only; clicking it opens the brief (`open-thread` in session storage). Home shows "Today's brief";
  Settings › Morning brief sets the time and makes one now; voice tool `get_brief` (guarded). The E2E harness turns the
  brief off so it never lands in another test.

### Wave 2 — Phase 0a foundations (built 2026-10-12)

Plan: [wave2-plan.md](wave2-plan.md). Built by the lead so the parallel streams never edit the same files:
- **Pinned extension ID** `fckijnclcihjnokahdnbogpbeiimfdio` (manifest `key` = public half of `dist.pem`, which stays
  out of git). Data starts fresh once on the next load.
- `src/shared/lib/errors` (`AppError`, `toAppError`, `parseRetryAfter`), `src/shared/lib/retry` (`withRetry` with
  full-jitter back-off and Retry-After, `RETRY_POLICIES`, `CircuitBreaker` with snapshot/restore).
- Dexie **v5**: tables `agents`, `bus`, `workflows`, `runs`, `runSteps`, `jobs` (unique `key`), `inbox` (unique
  `[source+externalId]`), `connectors`, `toolFingerprints`, `artifacts`, `modelCatalog`, `usageEvents`, `logs`; optional
  `agentId`/`origin` on threads, meetings and knowledge items. Record types in `src/storage/lib/<domain>/types.ts`;
  upgrade from v4 tested.
- `src/background/jobs/runner.ts`: the one scheduler (persisted jobs, one 30-s alarm armed once, cron via croner,
  catch-up window, leases + recovery, retry with back-off, two at a time).
- Registration points: `src/background/registry` (commands with zod validation, recovery, agent actions + prompt
  lines, voice tools — always guarded unless in `voice/guard.ts` — and offscreen busy checks) and
  `src/side-panel/registry.ts` (places for the drawer or profile menu, settings sections, `PanelApi` with request ids
  and timeouts). Each stream fills its own `register.ts(x)`; `registers.ts` imports them at startup. Panel routes run
  inside `RouteBoundary`.
- Tooling: `.claude/skills/avi-conventions` (the rules every stream loads), `scripts/check-locales.mjs`
  (`pnpm check:locales`), the `jsonunion` merge driver for locale files (`scripts/json-union-merge.mjs`,
  `.gitattributes`), `scripts/worktree-bootstrap.sh`, `test:e2e` runs every `e2e/*.e2e.mjs`. The E2E card wait now
  says what the panel showed when it times out. Under heavy machine load the gate tests can time out in a cascade;
  rerun when the load average is low.
- Wave A dependencies: `@xyflow/react`, `@dagrejs/dagre`, `react-force-graph-2d`, `@radix-ui/react-dropdown-menu`,
  `croner`.

### Wave 2 — WS3 Models, vault, usage (built 2026-10-12)

- **Secrets vault** (`src/storage/lib/secrets`): IndexedDB `avi-secrets`, AES-GCM under one non-extractable
  WebCrypto key made once (first context wins), the ref bound as associated data, every write read back before it
  counts. Only the background reads or writes secrets (`isBackgroundContext`); anyone may delete or ask `last4`.
- **Provider keys** (`settings/llmProviders.ts`): stored configs keep `hasKey`, `keyLast4`, `keyRef` and `apiKey: ''`.
  In the background `getProvider`/`getAllProviders` decrypt transparently; in pages they return `••••last4` (so old
  "has a key" checks keep working) and never the key. `getProviderSummaries()` is masked everywhere. A plaintext
  key found in `llm-api-keys` (old installs, tests, other writers) is moved by the background at start and 1 s after
  any change: vault write, read back, then blank, then `llm-api-keys-vault.migratedAt`. Local stand-ins ('ollama',
  'lm-studio') are not secrets. The options page's console dump of every provider (keys included) is gone.
- **NVIDIA NIM and LM Studio** are provider kinds (`nvidia`, `lmstudio`) with their base URLs; they run through
  createChatModel's OpenAI-compatible path. `llmProviderModelNames` is only a suggestion now.
- **Model registry** (`src/background/models`): job `models_refresh` (5 s after start when the last refresh is over
  an hour old, cron every 6 h, 2 s after a provider change, command `models_refresh`) lists Ollama (`/api/tags` +
  `/api/show`), LM Studio, OpenRouter (prices, context, modalities, tools), NVIDIA, OpenAI, Anthropic (paged),
  Gemini (key in a header, paged), xAI, DeepSeek, custom `/models`, Azure deployments → `db.modelCatalog`, with
  health per provider in `model-health` (`ok | error | unknown`, hints `ollama_origins`, `key_rejected`,
  `needs_key`, `unreachable`). 10 s timeout per try, `withRetry(connectorRead)`, a `CircuitBreaker` per host kept in
  `storage.session`. Only configured providers are called; the first run also probes `localhost:11434` / `:1234`
  and offers to add what it finds. Capabilities are tags (`storage/lib/models/capabilities.ts`).
- **Roles**: `resolveRole(role, { workspaceId, agentId })` and `createRoleModel(role, scope)`
  (`background/models/roles.ts`; the pure picker is `pickRoleModel` in storage): agent → workspace → user mapping,
  then the Planner (smart) / Navigator (fast) / speech-to-text (transcribe) settings, then the catalog by capability,
  health and a score. A provider that is down is stood in for by a healthy local model first; the embedding model is
  pinned the first time it is chosen automatically.
- **Usage v2**: every metered call is a `UsageEvent` (`recordUsage`, `recordPricedUsage` for audio minutes) with
  provider, role, agent, routine, run and workspace (a chat's from its thread). Cost: local servers free, Gemini's
  table, then the registry's price; unknown → `costUsd: null`, counted in `unpricedTokens`. The daily cost cap now
  counts every priced provider; models with no price stop at `modelSettings.unpricedDailyTokenCap` (default 2M
  tokens/day) in `ensureBudget` (and `isOverDailyBudget()` for background work). Retention job: 90 days.
- **Gemini Live tokens**: `mintLiveToken` (v1beta `auth_tokens`, one use, 30 min) and the constrained Live endpoint
  with `access_token`; the offscreen document can ask for one (`models_live_token`). Wiring it into voice and
  captions is the lead's (offscreen files).
- **Models & usage** page (`src/side-panel/models`, place `models` in the profile group): spending against both
  caps, providers with masked keys (edit, replace, remove, test through the background), local servers found, the
  catalog (search, local/cloud, price, context, capabilities, health, refresh), which model does what, and usage by
  day / model / agent / routine / workspace as SVG bars. The settings page's Models tab runs on the same
  `useProviders` hook over its own port (`models-settings`, `models_` commands only, extension pages only).
- Tests: vault, provider keys and migration (fake-indexeddb), discovery per provider (mock fetch), catalog refresh,
  roles, usage events and caps, Live tokens, commands; `e2e/models.e2e.mjs` (its own model-list server).

### Wave 2 — WS6 Interactive graph (built 2026-10-12)

Plan: [wave2-plan.md](wave2-plan.md) § WS6. Replaces the canvas in the "Knowledge graph" entry above.

- `src/side-panel/kb/GraphView.tsx` now renders with `react-force-graph-2d`: live d3-force physics that settles
  (`d3AlphaDecay` tuned for a ~2 s settle, not the default's five-plus), drag-to-pin (`fx`/`fy` on drop, double-click a
  pinned node to release and reheat), wheel/pinch zoom and pan, hover dims everything but the hovered node's
  neighbours, click focuses — the focus card, trail, search and "most connected" are unchanged (the accessible way
  in), so `e2e/kb.e2e.mjs`'s graph test needed no changes. Curved links carry particles only on the focused node's
  links, off under `prefers-reduced-motion` or past 800 shown nodes. Colours are read from the theme's CSS variables
  at actual paint time (`onRenderFramePre` refreshes a ref once a frame; project = `--primary-rgb`, person =
  `--call-rgb`, the rest a graded `--color-foreground` alpha; amber `hold` is never used), so light/dark and a live
  theme toggle both work. Node objects are cached and mutated in place across live Dexie updates (`simNodesCache`) so
  position and pins survive a refresh instead of respawning; "Fit" plus an automatic zoom-to-fit on load.
- Level of detail (`src/side-panel/kb/graphData.ts`, pure, unit tested): the shown-node cap rose from 160 to ~2 000
  (`MAX_SHOWN_NODES`), with fewer always-on labels and a higher label-by-zoom threshold as the count grows, particles
  off past 800. Found the hard way: at ~2 000 nodes the ~4 000 *edges* were the real bottleneck, not the nodes —
  compositing thousands of overlapping low-alpha strokes saturates to a solid black blob well before the node cap
  matters. `levelOfDetail().maxLinks` + `capLinks()` thin the rendered (and simulated) edge set to the busiest ones
  past 800 nodes, always keeping every link the focused node actually has; link alpha also scales down with the
  rendered link count.
- Filters: workspace (existing, lifted into `KnowledgeView`), agent (new `AgentPicker.tsx` next to the workspace
  picker, reads `db.agents` directly since there is no agent store yet, hides itself when empty), type chips
  (existing), time range (new chip row: 7 / 30 / 90 days / all). A graph node carries no `agentId` of its own;
  `graphData.ts#nodeAgentIds` derives it from `sourceItemIds` against a `kbItems.agentId` index built from
  `kbStore.items()`. The agent picker also narrows the Saved tab and is threaded into `onAsk`/`onSavePage` (now
  3-arg/2-arg callbacks — `SidePanel.tsx`'s 2-arg/1-arg implementations still type-check, TS allows fewer params, but
  **do not yet forward agentId to the kb_ask/kb_save_page messages**; see "Not done" in the stream's report).
- Pop-out: `entrypoints/graph/index.html` + `src/graph-page/*`, the same `GraphView` in a full tab
  (`chrome.tabs.create(chrome.runtime.getURL('graph.html'))`), workspace/agent carried as `?workspace=&agent=`. No
  manifest or `wxt.config.ts` change: WXT builds an unlisted page from the entrypoint folder exactly like
  `meeting-ask.html` already does (confirmed in a built `dist/manifest.json`: no `graph.html` reference anywhere, and
  `sidePanel` permission is already auto-added by the `sidepanel` entrypoint).
- Locale keys (`graph_` prefix, all three locales): `graph_fit`, `graph_popout`, `graph_filters_label`,
  `graph_filtered_empty`, `graph_agent_label`, `graph_agent_all`, `graph_time_label`, `graph_time_7d`/`_30d`/`_90d`/`_all`.
- Tests: `src/side-panel/kb/__tests__/graphData.test.ts` (30 cases — agent derivation, time range, degree,
  level-of-detail, link capping). `e2e/graph.e2e.mjs`: seeds `graphNodes`/`graphEdges`/`kbItems`/`agents` straight
  into IndexedDB, asserts the canvas region renders, click-to-focus through the "most connected" list opens the right
  focus card, the agent picker narrows the graph, Fit doesn't throw, zero console errors and zero
  `securitypolicyviolation` events. `node e2e/manual/graph.mjs <dir>` now also seeds a ~2 000-node/~4 000-edge graph
  and prints interaction timings (single-digit to low-hundreds of ms in a local run).

### Wave 2 — WS2 Voice out & retry (built 2026-10-12)

`src/background/tts` (`speak`/`stop`/`speaking` behind one interface, `markdown.ts` strips headings, lists, code,
links and emoji to speakable text, `chunk.ts` breaks it at sentence ends for an engine that must queue utterances up
front), `src/offscreen/tts.ts` (a one-clip `<audio>` player), `src/storage/lib/settings/ttsSettings.ts`
(`readAloud: off | voice | always`, engine, voice, rate, plus the session-storage "who's speaking" flag every panel
reads live), `src/side-panel/chat/*` (Speak/Stop and Retry in `ChatView.tsx`, the settings section), the error strip
in `src/side-panel/threads/ThreadBar.tsx`, `e2e/speak.e2e.mjs`.

- **Engine A, system voices (default)**: `chrome.tts` straight from the background; every chunk is queued with
  `enqueue: true` up front (bar the first, which clears anything already speaking) because Chrome's own queue lives
  outside the worker, not in it.
- **Engine B, Gemini TTS (optional)**: the background fetches audio with the Gemini key (`background/tts/gemini.ts`,
  REST `generateContent` with `responseModalities: ['AUDIO']`), wraps the raw PCM in a WAV header
  (`background/tts/wav.ts`) and hands only the resulting `data:` URL to the offscreen player — the key never crosses
  that boundary. `registerOffscreenBusy('tts', …)` keeps the offscreen document open while it plays.
- **Auto read-aloud**: a `db.threads.hook('updating', …)` in `background/tts/register.ts` (a second, independent
  hook from the knowledge base's own) fires when a run settles to idle; `shouldAutoSpeak()` (`decision.ts`, unit
  tested) decides from the setting, the thread's `origin`, whether the Gemini Live conversation is running (it
  announces itself) and the last spoken message id, so nothing is ever read twice.
- **Retry**: command `thread_retry` re-runs `ThreadManager.retry`. **Retry from here**: command `thread_retry_from`
  forks the thread just before a user message (`threadStore.fork(threadId, seq - 1)`) and sends that message's text
  again in the fork (`retryFromMessage()`, `retry.ts`, unit tested with a fake store) — `fork()` itself does not
  carry over `workspaceId`/`agentId`/`origin`, so the command copies them from the source thread straight after.
  Shown: under the latest answer and in a failed turn's run trail (`ChatView.tsx`), in `ThreadBar`'s error strip for
  every error kind (it hid Continue, not Retry, for `failed`), and "Retry from here" next to Branch on user messages.
- **Not done**: KittenTTS/local engines (WS8), speaking up on its own (WS5c), a Gemini TTS voice picker (system
  voices only in Settings › Voice output; Gemini uses its default voice).
- **Needs the lead** (not this stream's files): one line in `src/side-panel/registers.ts`
  (`import './chat/register';`), the offscreen router in `src/offscreen/index.ts` (`tts_play` / `tts_stop` /
  `tts_running`, see the WS2 handback), and `SidePanel.tsx` wiring `onRetry`, `onRetryFrom`, `onSpeak`,
  `onStopSpeaking` onto `ThreadBar`/`ChatView` (verified working locally, then reverted so this stream's diff stays
  inside its own files).

### Wave 2 — WS5a Workflows (built 2026-10-12)

Routines the user asks for in chat, drawn as a diagram, confirmed with a click, run on their own.
- **Spec** (`src/background/workflows/spec.ts`, zod, pure): triggers (schedule, manual, event, tab), steps (http_get,
  web_search, browse, read_page, memory_search/save, llm, condition, agent, tool, sandbox) and outputs (inbox,
  brief_section, notify, speak). Checks: one-way graph from a trigger, ≤ 30 nodes, one schedule at most every 5 min,
  fetched hosts on `allowHosts`, budget. Data moves through `{{steps.<id>.output}}` places (`template.ts`, no eval),
  allowed only in data fields; instructions, tasks and addresses are always literal.
- **Engine** (`engine.ts`, pure, storage and step work injected so the companion can reuse it): a persisted run and one
  step per node, `queued → running → waiting_user → succeeded | failed | cancelled | interrupted | unknown_outcome`
  (steps can also be `skipped`); retry with back-off only for steps safe to repeat (never model calls, never side
  effects); a side-effect step always waits for the user's click (Inbox approval, amber Allow in the panel) and, cut off,
  becomes `unknown_outcome`; budget (steps, model calls, tokens, daily cap); cancellation; lease + heartbeat and
  `recover()` (recent runs resume, a browser task picks up its chat, older runs are `interrupted`); taint; three failed
  runs in a row pause the workflow. Kinds still being built (agent, tool, sandbox, speak, tab trigger) stop a run with a
  plain message until a stream calls `registerStepExecutor`.
- **Service** (`service.ts`): drafts (`WorkflowRecord.draft`, diffed against what runs now or the draft it replaces),
  Create/Apply, hand edits (name, cron, instruction), pause/resume, delete; one job per active schedule
  (`workflow:<id>`, 2 h catch-up), one run per firing, runs per day cap; event triggers (`meeting_ended` wired by a
  Dexie hook; `fireEvent('inbox_item', …)` for the Inbox stream, never on workflow-made items).
- **Authoring** (`authoring.ts`, `actions.ts`): `create_workflow`, `update_workflow`, `run_workflow`, `list_workflows`
  agent actions; the routine is written by a separate `generateStructured` call (flat key/value shape every provider
  accepts, one correction round), never by the navigator's output; refused in chats started by a routine or an agent.
  Voice tools `run_workflow`, `list_workflows`.
- **Panel** (`src/side-panel/workflows`): place "Workflows" (list: review first, next run, last result; template
  "Morning tech news"), the React Flow + dagre diagram with per-kind cards, the draft diff (new / changed / removed
  ghosts), live step lighting, node inspector with edits and step output, run history, approvals; full-tab editor
  `workflows.html` (`entrypoints/workflows`, `src/workflows-page`) over one-off messages to the same commands.
- **Brief**: `out.brief_section` keeps its section in the step output; the brief includes today's sections, waits while
  a feeding workflow runs or is due, and a section that lands after the brief is added to its chat once.
- Tests: 53 unit tests (spec, templates, diff, engine with fake clock — retry, approvals, cancel, park/wake, restart
  recovery, auto-pause, budget — authoring with a mocked model, http_get, service, brief, diagram layout);
  `e2e/workflows.e2e.mjs` (chat → draft diagram → Create → feedback → Apply → Run now → nodes succeed → brief has the
  section). `e2e/manual/flow-shots.mjs` takes the panel screenshots. The test-only `workflow-settings.urlOverrides`
  points real sources at a local server (local targets only).

### Wave 2 — WS1 Shell & account (built 2026-10-12)

Plan: [wave2-plan.md](wave2-plan.md) § WS1. Drawer top = New chat, search, Home/Today/Meetings (core) merged with
`registeredPlaces('top')` and sorted by `order` (gaps at 10/40/50 left for Inbox/Workflows/Agents), then chats by
date unchanged. Knowledge base and Settings left the top list; the drawer's foot is now a profile button (initials
avatar from a new `accountProfileStore` display name, "You" when unset, a "Local" chip) opening an upward popover —
Knowledge base, Workspaces, Connectors, Skills, Models & usage, Settings, How do I… (core + `registeredPlaces('profile')`,
same `order` merge) — above the existing archived/pop-out row.

One menu primitive, `src/side-panel/components/ui/row-menu.tsx` (`@radix-ui/react-dropdown-menu`: portal, solid
`bg-popover` + blur, shadow, collision-aware, Esc/outside/focus/arrow-keys free), replaces the chat row's old
see-through, clipped "⋯" menu (`layout/Sidebar.tsx`'s `HistoryRow`) and is the profile menu. The drawer's own
Escape handler now steps back one layer at a time: it skips closing the drawer while `document.querySelector('[role="menu"]')`
finds an open menu, so a first Esc closes the open menu and a second closes the drawer.

**Default workspace**: `workspaceStore` (`src/storage/lib/workspaces/workspaces.ts`) gained `defaultWorkspaceId` +
a one-time `defaultWorkspaceMigrated` flag — `ensureSeeded()` gives a brand-new install Nexprove as the default as
part of normal seeding, and gives an install that was already `seeded` (from before this field existed) the same
default once, without ever overwriting a default the user later picked or cleared; removing the default workspace
clears it back to none rather than silently pointing at a gone id. New place `workspaces` (registered profile,
order 10, from `src/side-panel/account/register.tsx` — `registers.ts` only imports that one file for this stream,
so every place WS1 registers goes through it) shows the same list/add/edit as before (`WorkspacesSettings.tsx`,
now with a star per row to set or clear the default, `useDefaultWorkspaceId()` alongside the existing `useWorkspaces()`)
plus what the star means. **Not wired to Home**: the actual `<WorkspacePicker>` on Home is instantiated in
`SidePanel.tsx` (shared, not ours), so preselecting it needs that file's `nextWorkspace` state initialised from
`workspaceStore.getDefaultWorkspaceId()` — reported to the lead, not done here. Same reason `ThreadManager.placeInWorkspace`
still returns with no workspace when nothing is picked or routed; the one-line fallback to the default is reported too.

New place `skills` (registered profile, order 30) moves the on/off list that lived in Settings (`SkillsPlace.tsx`,
`src/side-panel/skills/`, new file, `TeachCard.tsx` untouched) plus a line on how teaching a skill actually happens
(after a task, never from this page). Settings (`settings/SettingsView.tsx`) regrouped: General (new name field via
`accountProfileStore`, `src/storage/lib/account/`, + the theme radios that used to be their own section), Voice,
Morning brief, Obsidian, Agent behaviour (the read-only Model row — now a button to `api.go('models')` when
registered, else the full options page — confirm gate, spending, writing style, highlights, all merged), Meetings,
Calendar, Memory, then `registeredSettingsSections()` appended. This needed `api: PanelApi` on `SettingsViewProps`,
so its one call site in `SidePanel.tsx` also needs `api={panelApi}` — reported. `HelpView.tsx` gained entries for
workflows/inbox/agents/connectors/default workspace/read aloud (absent targets degrade to Home, same as any
unregistered place) and pointed the existing "models"/"skill" entries at their new homes.

E2E `e2e/shell.e2e.mjs`: the top list drops Knowledge base/Settings, the profile menu opens upward with its items,
the row menu is portaled outside the scrolling history region and stays fully on screen at 400×760, Esc closes one
layer at a time, and the default workspace persists across leaving and returning to the Workspaces place.
`e2e/kb.e2e.mjs`'s `openKnowledge()` helper and its two `Settings` flows now click `Account menu` first (reported
below instead of changed silently). Screens: `node e2e/manual/shell.mjs <dir>`.

**Two Radix/E2E gotchas for any stream adding a floating menu, popover or dialog** (found building
the row menu): (1) `@radix-ui/react-dropdown-menu`'s trigger opens on `pointerdown` or a keyboard
Enter/Space, never `click`, so the harness's `session.click(label)` (a synthetic
`element.click()` run through `evaluate()`) never opens it; Puppeteer's own `ElementHandle.click()`
is not a fix either — with this Brave build under CDP it hangs inside `clickablePoint()`'s
`Runtime.callFunctionOn` round trip until the default 180000ms `protocolTimeout`, every time. Open
it by focusing the trigger and dispatching a real `keydown` for Enter instead, inside one plain
`evaluate()` call (see `openAccountMenu`/`openRowMenu` in `e2e/shell.e2e.mjs`). (2) Any
`Presence`-based exit animation (what `data-[state=closed]:animate-out` + friends gives a Radix
content) will not unmount at all — not eventually, not after a long wait — unless the page is the
foreground tab: a background tab gets no animation frames (already noted above for `MorphOrb`), so
`animationend` never fires and `Presence` waits forever in `unmountSuspended`. Call
`session.panel.bringToFront()` before opening or closing one, and after anything (`session.send`)
that refocuses the web page.

- **Wave B dependencies (lead, 2026-10-12):** `@modelcontextprotocol/sdk` + `@cfworker/json-schema` (MCP without
  eval), `kitten-tts-js` + `@huggingface/transformers` (local voices and speech recognition, loaded on demand); the
  `identity` permission for connector sign-in. Routines pick models through `createRoleModel`; the graph, the brief and
  routines hold on the shared daily budget (`isOverDailyBudget`).

- **Gemini Live tokens (lead, 2026-10-12):** with Google's endpoint the API key never reaches the offscreen document:
  each Live connection (voice and live captions) asks the background (`models_live_token`) for a one-use token locked
  to the Live model in settings and connects to the constrained endpoint with `access_token`
  (`src/offscreen/liveAuth.ts`, `usesLiveTokens`). Test endpoints keep the key path.

### Wave 2 — WS5b Agents & run log (built 2026-10-12)

Agents that work for Avi on their own, in a window of their own. `src/background/agents`, `src/storage/lib/agents`,
`src/side-panel/agents`, `e2e/agents.e2e.mjs`, locale keys `agents_`.

- **Profile** (`profile.ts`, pure, zod): name, avatar, instructions, sites (host names), start page, model role
  (smart/fast/vision/local), workspace, triggers, topics it posts to and listens to, skills (loaded as `/name` in its
  task), budget (USD a day, model calls a run, runs a day), "results in the Inbox". Checks: schedules via
  `checkSchedule` (≥ 5 min apart), watched patterns must name a site (`*`, `*.com` refused), the start page on its
  sites, no topic it both posts to and listens to, the companion executor refused until WS7. Drafts never run:
  `create_agent` / `update_agent` (refused in chats an agent or routine started) write the profile with a separate
  structured call (`authoring.ts`, one correction round) and save `AgentProfile.draft`; the panel shows each changed
  field (old struck through) with Create/Apply/Discard. Hand edits in the panel apply directly (the user's click),
  checked the same way. Templates "Social media watcher" and "Research scout".
- **Runs** (`service.ts`): a `RunRecord` kind `agent` with steps `trigger` → `task` (its chat; state: thread, tab,
  window, start page) → `publish`; queued → running → waiting_user → succeeded | failed | cancelled | interrupted. The
  task is a chat (`origin: 'agent'`, archived so it stays out of Avi's list, model from `resolveRole(agent.modelRole)`)
  created already bound to a tab of the agent's group in the **agents' window** (`window.ts`: one window made
  minimized and unfocused, a named, coloured tab group per agent, `autoDiscardable: false`, idle tabs reused, three
  kept), then started with `threads.send({ threadId })` — no ThreadManager change was needed. A run starts only when
  `runningCount < maxConcurrentThreads - 1` (one slot always Avi's; it waits with a job, gives up after 30 min) and
  one run per agent at a time (deliveries queue behind it). While it runs: its model calls (usage events of its
  chat) are counted against max steps, its dollars against the daily cap, its tabs against its sites (it is stopped
  when it leaves them); a click it waits for becomes an Inbox approval (`thread:<id>` / `open_thread`). After: answer
  on the task step, an Inbox result for unattended runs, alerts for failures, auto-pause after 3 failures in a row,
  old runs pruned (50 kept). Recovery: never-started runs wait again, recent runs are followed again (the thread
  manager resumes their chat), old ones are interrupted. Agents only run while every confirm kind asks for a click
  (`gateAsksForAll`), because they act alone.
- **Triggers**: schedules (one job per schedule trigger, `agent:<id>:<n>`), watched pages (`chrome.tabs.onUpdated`,
  2.5 s quiet, once per page per 10 min and at most once a minute per agent; never private windows, the agents'
  window, a tab a chat is working in, or a page the firewall blocks; the agent opens its own copy of the page),
  Inbox items (a Dexie `creating` hook; items agents or routines left never wake one; workspaces kept apart), bus
  topics. Runs set off by a page, an Inbox item or the bus are **tainted**: what set them off is passed wrapped as
  untrusted data. Routines' `trigger.tab` fires from the same watcher and `step.agent` runs the named agent
  (`workflow-step.ts`, parked until the agent's run ends); both left `NOT_YET_AVAILABLE`.
- **Bus** (`bus.ts`): a successful run posts its answer to its topics (`id = <runId>:<topic>`, so never twice); every
  created, switched-on listener in the same workspace gets a run (firing key per message and agent: at-least-once,
  redelivered after a restart, budget refusals settle it); hops counted, past 3 dropped (kept for the log); taint
  carried. Messages kept 7 days.
- **Panel** (place `agents`, top, order 50): list (review first, state idle/running/waits for you/paused/draft, next
  schedule, spend today, templates); agent page: draft diff, profile and editor (triggers editor included), its tabs
  (click shows the tab in the agents' window), runs with the **run log** (`runlog.ts`, pure: trigger, start page,
  task, plans, actions, notes, retries, errors, every model call with tokens and cost, Inbox asks, posts, end; summary
  of duration, calls, tokens, cost, retries, errors; "Open chat"), its knowledge (items, Knowledge base, graph tab
  `graph.html?agent=`), usage today / 7 days / all.
- Voice tools `list_agents`, `run_agent` (guarded); chat actions `create_agent`, `update_agent`, `run_agent`,
  `list_agents`.
- Tests: 76 unit tests (profile, patterns, debounce/cooldown, Inbox matching, bus hop limit/taint/dedupe/redelivery,
  budgets, auto-pause, slot for the user, recovery, gate guard, run log, authoring, step.agent, actions refusal);
  `e2e/agents.e2e.mjs`: chat → draft → Create → Run now runs in the agents' window (focus and Avi's tab untouched) →
  run log → a matching page Avi opens wakes it again, tainted.

### Wave 2 — WS4 Integrations (built 2026-10-12)

Plan: [wave2-plan.md](wave2-plan.md) § WS4. Remote MCP servers become tools the agent and routines can use.
- **Connectors** (`src/background/integrations`, record types in `src/storage/lib/integrations`): add / edit / remove
  remote MCP servers (Streamable HTTP; a server that answers the way old servers do, 400/404/405 to a POST, is tried
  over HTTP+SSE once and the transport kept). Addresses must be https (plain http only for loopback); no
  credentials in the address. Bound to workspaces (`workspaceIds`, empty = nothing may use it; a chat in no
  workspace gets none); a chat run as an agent (`thread.agentId`) only gets the connectors its profile lists. One
  short MCP session per piece of work (`client.ts`: connect, work, DELETE the session), a new session once when the
  server forgot it (404 with a session id: the request was not handled, so even a write is safe to resend), a time
  limit per connector (2–120 s, default 30), one `CircuitBreaker` per connector (in `storage.session`), `withRetry`
  (`connectorRead`, Retry-After honoured) only for reads; a timed-out tool call is never retried. SDK errors map to
  `AppError` with plain sentences; a server's own words never go into them (only a refused call's detail, wrapped
  as untrusted). `@cfworker/json-schema` validates arguments and output (no eval; the E2E counts CSP violations).
- **Sign-in**: none, a token (vault `conn:<id>:token`, header `Authorization: Bearer` or one the user names), or OAuth
  2.1 + PKCE (`oauth.ts`): 401 challenge → RFC 9728 resource metadata → RFC 8414/OIDC discovery (SDK helpers),
  dynamic client registration when offered, else the user's client ID (+ secret, vault `conn:<id>:client`); the
  authorization server and its endpoints must be https (or this computer) before anything goes to them; S256,
  a 32-byte state, the RFC 8707 resource, the challenge's scope (else the server's). The verifier and state wait in
  `storage.session` (15 min, single use); **the panel** runs `chrome.identity.launchWebAuthFlow` (redirect
  `https://<extension id>.chromiumapp.org/`) and hands the answer back (`conn_oauth_finish`), so a background stopped
  while the user types their password loses nothing. The answer must come to the extension's redirect with a known
  state and the right `iss` (RFC 9207). Tokens in the vault (`conn:<id>:oauth`), renewed a minute before they run
  out, one renewal per connector however many calls wait (single flight); a refused token is renewed once and the
  call tried again; a dead refresh token sets "Needs sign-in" and posts one Inbox alert ("Sign in to X again").
- **Tools and fingerprints** (`fingerprint.ts`): SHA-256 of name + description + input schema (canonical JSON),
  read on connect, on "Check tools", every 6 h (job `connectors_refresh`) and before a call when the last reading is
  over 10 min old. New tools and changed ones are off until the user chooses; a changed tool keeps what it looked like
  when approved (shown as "Before: …") and loses its old choice. Choices are bound to the hash the user saw
  (`conn_tool_policy` refuses a tool that changed meanwhile) and written in one Dexie transaction with the listing,
  so quick clicks and a refresh never undo each other. Policy per tool: **Always allow** (`read`) / **Ask first**
  (`approve`, the default) / **Off**; "Always allow" on a tool whose server does not even claim `readOnlyHint` takes
  a second click.
- **Agent action** `call_tool({connector, tool, args})` (one action for every tool; `args` is JSON text so every
  provider's structured output takes it): checks scope, approval, policy and the JSON Schema before anything is sent;
  "ask first" tools go through `reviewToolCall` (`gate.ts`: a `ConfirmRequest`, mode `commit`, target `Connector ›
  tool`, one field per argument, the server's description deliberately left off the card; a refusal stops the task)
  and are refused in chats started by a routine, an agent or the brief ("needs an approval item"). Results are
  wrapped as untrusted, 10 000 characters at most; a write cut off mid-call says it may or may not have happened.
  The per-step catalogue (`section.ts`, `connectorToolsSectionFor`) lists the chat's usable tools with one-line
  cleaned descriptions and argument names (≤ 6 000 characters) — it needs one line in `agent/prompts/base.ts`
  (reported). Without it the agent learns the names from call_tool's refusals.
- **Routines**: `step.tool` executor (`step.ts`; removed from `NOT_YET_AVAILABLE` in `workflows/spec.ts`). Places in
  `args` are filled per JSON value (an earlier step's output can never add or change another field); a step marked
  read-only only runs a tool the user set to "Always allow"; other steps run after the engine's approval, once.
- **Panel** (`src/side-panel/integrations`, place `connectors`, profile menu): your connectors (status, tools to
  review), well-known servers checked against their own docs on 2026-10-12 — GitHub (`api.githubcopilot.com/mcp/`,
  personal access token), Linear (`mcp.linear.app/mcp`) and Notion (`mcp.notion.com/mcp`) with OAuth + dynamic
  registration, Slack (`mcp.slack.com/mcp`) and Gmail / Google Calendar / Google Drive (`*mcp.googleapis.com/mcp/v1`,
  Google's documented scopes, `access_type=offline`) with the user's own client — plus "Add custom server" and a
  disabled "Mac companion" entry. A connector's page: status, workspace chips, sign in / reconnect / replace token,
  on/off, Check tools, each tool with its badges, arguments, choice and drift warning.
- **Companion**: `companion.ts` defines `CompanionToolBridge` (`available`, `listTools`, `callTool`) and
  `registerCompanionToolBridge` for WS7; connectors of kind `mcp_stdio` / `cli` say they need Avi Brain until then.
- Tests: 69 unit tests (fingerprints and drift, policy, schema checks, OAuth begin/finish/PKCE with a mocked
  `launchWebAuthFlow`, state/issuer/redirect checks, sign-in addresses that must be https, single-flight renewal,
  the catalogue's lines, result formatting, the service against the SDK's own server
  through a fake fetch — 429 retried, writes once, timeouts, session re-init, breaker, concurrent choices — call_tool
  with the gate, step.tool, the panel's sign-in); `e2e/integrations.e2e.mjs` (10, Brave) with `e2e/mock-mcp.mjs`
  (read, write, changing, 429, slow and injection tools, plus an OAuth shim): add → tools new → choices → read tool
  from the agent → confirm card for the write → 429 retried → slow tool cut at 3 s → changed tool off and not
  called → injection wrapped and blocked → OAuth sign-in through `launchWebAuthFlow` with tokens only in the vault →
  no CSP violation in the worker or panel. Screens: `node e2e/manual/connectors-shots.mjs <dir>`.

### Wave 2 — WS5c Inbox & sources (built 2026-10-12)

Plan: [wave2-plan.md](wave2-plan.md) § WS5c. One place where agents, routines and connectors leave what needs Avi.

- **Service** (`src/background/inbox/store.ts`): `addInboxItem(draft)` dedupes by `source+externalId` (the same
  `source|externalId` id convention as `workflows/inbox.ts`'s own `postToInbox`, kept as an independent copy rather
  than an import so neither stream depends on the other's internal file — both must simply keep agreeing on the
  format) and folds a source's "message" items into one digest once more than `RATE_LIMIT_THRESHOLD` (5) land
  within `RATE_LIMIT_WINDOW_MS` (10 min); the digest keeps counting while the burst continues and wakes back up if
  already marked done when more arrive. Approvals, results and alerts are never folded. `markRead` / `markUnread`
  / `markDone` / `snoozeItem` (wakes via a one-off job, `inbox-snooze:<id>`, which checks the item is still snoozed
  before waking it) / `pruneDone` (30 days, daily cron `inbox_retention`).
- **Badge** (`src/background/inbox/badge.ts`): the global `chrome.action.setBadgeText` (no `tabId`), skipped
  entirely while any meeting records. Meetings only ever set a *per-tab* override (confirmed by reading
  `meetings/manager.ts`'s `setBadge`), so the two never collide and no lead change was needed. Two independent
  Dexie hooks on `db.inbox` / `db.meetings` (the same pattern WS2 used on `db.threads`, in `src/background/inbox/
  register.ts`) keep the badge, a workflow event trigger (`workflowService.fireEvent('inbox_item', …)`, which
  self-excludes workflow-sourced items), a throttled desktop notification and the announcer wired for *every*
  writer to `db.inbox` — including `workflows/inbox.ts`'s own direct `postToInbox` calls, not only this stream's.
- **Approvals** (`src/background/inbox/approvals.ts`): `registerApprovalHandler(prefix, fn)` dispatches an
  Inbox answer by its request id's prefix; this stream registers `workflow-step:` → `workflowService.answerRequest`
  (`APPROVAL_PREFIX` imported from `workflows/inbox.ts`). WS5b and WS4 add their own prefixes later with no change
  here. Panel: inline Approve/Decline on an approval row and in its detail view (command `inbox_answer`, field
  named `approvalRequestId` rather than `requestId` — a command's own data must never reuse that name, since
  `PanelApi.request` already adds a protocol-level `requestId` of its own for reply correlation that would
  silently clobber it; this exact collision was caught by the E2E approval test before being fixed). An item whose
  `approval.action === 'open_thread'` carries `thread:<id>` in its request id and opens that chat instead
  (`meta.ts#openThreadId`) — wired in the panel, with no current producer.
- **Sources** (`src/background/inbox/watchers/`): tab watchers for WhatsApp Web, Slack web and Gmail web, each a
  pure URL matcher (unit tested) plus a self-contained `chrome.scripting.executeScript` probe. The probe itself is
  DOM-touching and, like `gate/probes.ts`'s own `inCall`/`readFocus`, is not unit tested — this project's Vitest
  has no DOM environment (no jsdom/happy-dom dependency; confirmed before relying on the existing untested-by-design
  convention rather than guessing) — so it is covered by the E2E fixture test instead. `runWatchers()` (job
  `inbox_watch`, every 2 minutes, plus a "Check now" button in Inbox settings for an immediate read) reads every
  open, non-incognito tab matching a watcher the user turned on, respects the firewall (`isUrlAllowed`, the same
  check `voice/browser-tools.ts` uses), and reads only unread conversations already on screen. A new "message" item
  is summarised (`summarize.ts`) by a tool-less `generateStructured` call (role `fast`, the same
  resolve-then-fall-back-to-agent-settings shape as `workflows/models.ts`'s `workflowModel`) into a fixed
  `{line, whyItMatters}`; the raw snippet is wrapped with `wrapUntrustedContent` first, and the summary replaces
  the body only — the title (the sender's name) is left alone, and is also as far as the announcer or `read_inbox`
  ever go verbatim. Skipped, leaving the raw snippet, over budget or on any failure. `addInboxItem` is exported for
  WS4's connector pollers to call later.
- **Speaking up** (`src/background/inbox/announcer.ts`): a high-priority item or an approval, or (a second
  subscription to `CalendarWatcher.onReminder`, alongside `index.ts`'s own) a meeting about to start, becomes one
  short line — the Live conversation speaks it when one is on, `tts/speak.ts` otherwise — gated by "Speak up when
  something needs me", quiet hours (wraps past midnight) and a minimum gap between any two announcements. Never
  reads a body aloud, and never a meeting's title either (matching `index.ts`'s own existing reminder line, which
  the same reasoning already avoids). Desktop notifications (`notify.ts`) for high priority only, same throttle
  shape, title only.
- **Panel** (`src/side-panel/inbox/`): place `inbox` (top, order 10, the shared unread count as its live badge),
  filters (all / unread / approvals / source / workspace / agent — the workspace and agent filters read
  `workspaceStore`/`db.agents` directly rather than importing WS1's `useWorkspaces` hook or duplicating a store
  that does not exist for agents yet, the same choice WS6's `AgentPicker` made), rows with a source icon, title,
  time and priority dot, a detail view (the body as plain text, a link opens in a new tab only on an explicit
  click, never automatically), mark done/unread, two snooze presets, "Open chat" for an `open_thread` approval or
  "Open workflow" otherwise. Settings section "Inbox": the speak-up switch, quiet hours, and the three watcher
  toggles with "Check now". Voice tool `read_inbox` (counts, how many are approvals, and the top items' titles,
  `wrapUntrustedContent`-wrapped).
- Tests: 54 unit tests across 8 files (dedupe, digest fold/reset-after-the-window/wake-on-more-messages, rate
  limit, retention, snooze set and wake-only-if-still-snoozed, badge vs. a recording meeting, approval routing with
  a fake stand-in for `workflowService`, announcer quiet hours (including the midnight wrap) and the minimum gap,
  notify throttle, the summariser with a fake model — untrusted wrapping, a budget skip, a graceful failure
  fallback — URL matchers, draft normalisation from already-extracted rows). `e2e/inbox.e2e.mjs`, fixtures under
  `e2e/fixtures/inbox/`: seeded items (straight into IndexedDB, as `e2e/graph.e2e.mjs` and `e2e/kb.e2e.mjs` already
  do) show with the filters narrowing the list and the badge updating off a real write; a workflow approval seeded
  straight into `workflows`/`runs`/`runSteps`/`inbox` (no side-effecting step type is wired into the engine yet,
  so there is no way to reach `waiting_user` by actually running a workflow — seeding is the brief's own sanctioned
  path) is answered inline and the run/step/item all settle, found by id rather than array position since earlier
  tests' rows share the same database; a WhatsApp-Web-like fixture page, served by request interception the same
  way `e2e/voice.e2e.mjs` does for meet.google.com, posts its two unread conversations through the tab watcher and
  skips the one already read.
- **Not done**: `registerApprovalHandler` only has the one prefix so far (WS5b/WS4 add theirs when they exist);
  connector pollers themselves are WS4's, beyond exposing `addInboxItem` for them; "open the related... run" in
  the panel spec only reaches a *chat* (`PanelApi.go(place: string)` takes no parameters, so a specific workflow
  run cannot be deep-linked — the detail view's "Open workflow" button opens the Workflows place in general
  instead, which is as close as the current API allows).
- **Needs the lead**: nothing required — the badge, the approval wiring and the event trigger were all reachable
  through existing registration points and Dexie hooks without touching a shared file. If deep-linking an Inbox
  item straight to one workflow run (rather than the Workflows place in general) is wanted later, `PanelApi.go`
  would need an optional second argument.

### Wave 2 — WS8 Voice engines, free and local (built 2026-10-12)

Plan: [wave2-plan.md](wave2-plan.md) § WS8. Settings › Voice engines picks who hears, who speaks and how a conversation
runs; nothing but text ever leaves the computer in economy mode.

- **Models** (`scripts/voice-models-setup.mjs`, git-ignored `public/voice/`, `voice/manifest.json`): every file from a
  pinned Hugging Face revision with a pinned SHA-256; default KittenTTS nano 0.8 int8 (~28 MB, 8 voices; `voices.npz`
  unpacked into raw float32 files so the extension needs no zip reader) + Moonshine tiny int8 (~32 MB); flags
  `--moonshine-base` (~67 MB), `--whisper` (Whisper base, ~80 MB), `--kokoro` (Kokoro 82M q8 + 8 voices, ~97 MB),
  `--webgpu` (Moonshine float weights), `--all`, `--list`. Vosk dictation reuses the wake word's model. Rebuild after.
- **Runtime** (`src/offscreen/tts-local`, `src/offscreen/stt`): two module workers in the offscreen document, both on
  transformers.js 4.3 (`StyleTextToSpeech2Model` runs KittenTTS and Kokoro; the ASR pipeline runs Moonshine and
  Whisper; WebGPU when allowed and its weights exist, else WebAssembly). `configureTransformers` turns off remote models
  and Cache Storage and unsets onnxruntime-web's CDN `wasmPaths`, so the `.wasm` Vite emits next to the worker is used.
  Phonemes from eSpeak NG via kitten-tts-js's `phonemize`. No `eval`/`new Function` in any bundle that runs (JSZip's
  dead `setImmediate` path is never reached); the E2E follows the offscreen document and its workers over CDP and finds
  zero CSP violations and no request leaving the computer. A model stays loaded while used and is unloaded after
  5 idle minutes (or "Free memory"); answers are made sentence by sentence (first chunk ≤ 90 chars) with the models'
  leading/trailing silence trimmed; playback is measured by an AnalyserNode.
- **Measured** (Brave, M-series Mac, single-threaded WASM — extension pages are not cross-origin isolated): KittenTTS
  load 1.0–1.3 s, first audio ~0.9 s, 1.5–2.7× real time, ~+290 MB RSS while loaded; Kokoro load 1.0 s, first audio
  ~2.6 s, 0.4–0.5× real time (gaps between sentences), ~+600 MB; Moonshine tiny load ~1.0 s, 0.2 s for a 3 s utterance
  on WASM (0.4 s on WebGPU incl. shader compile); Moonshine base 0.33 s; Whisper base 2.5 s; Vosk 0.5–0.9 s, ~+110 MB.
- **Economy conversations**: the same Talk button, thread, tools and guard as Gemini Live. `createVoiceSession`
  (`stt/economy.ts`) gives the offscreen router an `EconomySession` when `voice_start` options say `mode: 'economy'`:
  mic → `SpeechGate` utterances (`stt/utterances.ts`, voiced 20 ms frames, so knocks are dropped) → local recogniser →
  `voice_engine_turn` to the background (`background/voice/engines/economy.ts`: `createRoleModel('fast' | 'local')`,
  `generateText` with `VOICE_TOOLS` + `registeredVoiceTools()` run by `services().voice.onTool`, stop at
  `end_conversation`, answer made speakable) → KittenTTS/Kokoro in the offscreen document, or the system voices from
  the background. Talking over the answer for 0.4 s stops it; an answer the user has talked past is not spoken; notices
  go through the model as in Live. Never Gemini audio; a local model skips the daily cap.
- **end_conversation** voice tool (free in `voice/guard.ts`) ends Live or economy through `services().voice.stop()`.
  **Idle end** for every conversation: quiet for the minutes set (default 3, 0 = never) with no task running or waiting.
- **Settings › Voice engines** (`src/side-panel/voice-engines`, order 66): mode, speech-to-text (+ Moonshine size, GPU
  switch), text-to-speech (the same `tts-settings.engine` Voice output uses) and voice, economy's text model, idle end,
  installed models with sizes and the exact setup command, "Say something", "Test speech-to-text", "Free memory".
- Tests: 9 unit files (settings and engine choice, turn loop with fakes in both halves, tools as JSON Schema, idle end,
  manifest, utterances, text, LocalTts with a fake worker); `e2e/voice-engines.e2e.mjs` (skips with the setup command
  when `public/voice` is missing).
- **Needs the lead** (not this stream's files; tested wired, then reverted): `import './voice/engines/register'` in
  `background/registers.ts`; `import './voice-engines/register'` in `side-panel/registers.ts`; `createVoiceSession` +
  `import './tts-local/register'` in `offscreen/index.ts`; economy options in `VoiceManager.start`; `kitten`/`kokoro`
  in `TtsEngineId`, `speak.ts` `engineFor`/`stopSpeaking` and Voice output's engine list; `end_conversation` added to
  the tool list `e2e/voice.e2e.mjs` asserts.

## 5. Risks, in order

1. **The gate misses a commit action.** This is the only risk that can do real damage (a sent email, a deleted record). Mitigation is layer 2 in section 3 and the M1 fixtures.
2. **Upstream drift.** v0.2.0 moved every file. Mitigation is the directory rule in section 2.
3. **Worker death in long agent loops.** Not solved upstream. Owned by M2.
4. **Speaker labels.** Audio transcribed in 30 s chunks will not give consistent speaker names across chunks. Names come from captions or the page when available, otherwise segments have no speaker. The spec already marks `speaker` optional.
5. **The debugger bar.** Dismissing it detaches the debugger and cancels the task. It is expected behaviour that needs a clear message, not a bug to fix.

---

## 6. Assumptions (say so if wrong)

- Sideloaded only. No Chrome Web Store submission.
- Private repo under `AviOfLagos`, not the `Nexprove-Team` org.
- Milestone order as in the spec. M3 depends only on the Dexie layer from M2, so it can be pulled ahead of the rest of M2 if meeting notes matter more than running several threads at once.
