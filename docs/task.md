# Nex Copilot — Build Plan

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

- [x] Clone `v0.2.0`, rename to Nex Copilot, build
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
  panel on opening and every 10 minutes: the knowledge base and graph are written into `Nex Copilot/<workspace>/`
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

### Models rework: one page, active models, local first for light work (2026-10-16)

Problems seen on the old screens (`node e2e/manual/models-shots.mjs <dir> <prefix>` takes 400 px shots): two model
UIs (the settings page's providers + "Models" chips + Planner/Navigator + speech-to-text, and the panel's providers +
catalog + roles) that did not agree — choosing the Smart role never changed the browser agent's Planner; every
discovered model was offered to every role (hundreds with OpenRouter); roles with nothing to pick said only
"none available yet"; Transcription offered models dictation cannot use; provider actions wrapped onto a second line;
no last-check time; nothing about local models beyond "found on this Mac".

- **One page** (`src/side-panel/models`, `ModelsHub`), tabs Models / Roles / Local / Usage. The settings page's Models
  tab renders the same hub over its own port (`options/components/ModelSettings.tsx`; the options Tailwind config scans
  the panel's models and ui folders and takes its colours). `options/components/models/ProviderCard.tsx` is gone.
- **Active models** (`storage/lib/models/active.ts`): a provider's saved model names are its active models (what the
  old "Models" chips edited); a provider with none saved offers all it lists. The registry turns on a sensible few the
  first time it lists a provider with none (`seedActiveModels` in `catalog.ts`: every local chat/embedding model, or a
  cloud provider's best per role). Switches write `llmProviderStore.setModelNames` (keys untouched; not a refresh
  trigger). The last model of a provider stays on; models a role/agent/pinned embedding uses cannot be turned off.
  `pickRoleModel({ activeOnly: true })` (used by `resolveRole` and the page) ignores inactive models, mappings and
  agent models, but keeps the pinned embedding model. Each model row shows which roles it serves, and has a Test.
- **Roles** pick from active models only; Smart/Fast are also the browser agent's Planner/Navigator (one choice writes
  both, reasoning effort kept for OpenAI reasoning models); Transcription writes dictation's model when it is Gemini.
  Empty roles say what would fix them and offer "Turn on" for the best inactive model.
- **Local** (`storage/lib/models/recommend.ts`, pure): memory from `navigator.deviceMemory` (a floor at Chrome's 8 GB
  cap, Brave reports more) or the user's pick (`localMemoryGb`), cores, WebGPU adapter vendor → 2–4 Ollama models
  (chat, light, vision, embed) with size, why, `ollama pull …` (copy) or Installed + Test. `models_local_report`
  reads Ollama's `/api/tags` and `/api/ps`; `models_test_model` asks one model for "OK" (metered). The page says
  what a browser cannot see (real memory, disk, GPU memory).
- **Light-work routing** (`background/models/light.ts`, decision `storage/lib/models/routing.ts`): `lightModel(task,
  scope, fallback)` uses the active local model when "Prefer local for light tasks" is on (default) and its server
  answers (a 1.5 s list request remembered for a minute; 404 counts as up, 403/network failure does not). Otherwise
  it posts one Inbox alert ("Start Ollama to save cost — or allow cloud", `lightNoticeAt`) and uses the cloud's fast
  role; "Allow cloud for light tasks" (`lightCloudAllowed`) silences it. Used by Inbox summaries (`inbox/model.ts`),
  workspace summaries (`history/summaries.ts`) and routine model steps (`workflowModel('light')` in
  `workflows/executors.ts`). Local light calls record `light: true` and `savedUsd` (the replaced cloud model's price,
  `UsageScope.savedAgainst`); Usage shows "N light tasks ran locally, saving about $X".
- Not routed yet (other streams' files, one-line swaps to `lightModel(...)`): reflection (`identity/register.ts`),
  the brief (`brief/manager.ts`), chat summaries for `read_chat` (`chats/register.ts`), the graph builder
  (`graph/builder.ts`), meeting summaries (`meetings/manager.ts`).
- Tests: `storage/lib/models/__tests__/{active,recommend}.test.ts` (active filtering, defaults, toggles, roles, routing
  decisions, spec → recommendation rules), `background/models/__tests__/light.test.ts` (local running / not running /
  cloud allowed, the one-time notice, savings, 404 vs 403), catalog seeding; `e2e/models.e2e.mjs`: toggling models,
  roles offering only active ones, recommendations (and the memory pick), a workspace summary routed to the mock
  Ollama with its savings shown.

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
  `registerCompanionToolBridge` for WS7; connectors of kind `mcp_stdio` / `cli` say they need Nex Brain until then.
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

### Wave 2 — WS7 Nex Brain, the Mac companion (built 2026-10-12)

Plan: [wave2-plan.md](wave2-plan.md) § WS7. Details: [companion/README.md](../companion/README.md); spike:
[companion/SPIKE.md](../companion/SPIKE.md).

- **Spike verdict: eve, for agent sessions only.** A real eve 0.75.1 agent (`companion/spike/eve-probe`, `node
  probe.mjs`) passed 18/18 runtime checks: a model chosen per session (`defineDynamic` at `step.started`, any
  OpenAI-compatible endpoint), per-session instructions and an exact tool allowlist (profile id on the session's
  auth, `defaultTools: false`), fail-closed bearer + Origin auth on `--host 127.0.0.1`, approvals
  (`inputResponses`), stream resume (`startIndex`, stable ids), no traffic off the Mac and no secret on disk. Not
  eve's: sandbox limits (its Docker provider has none, per session), runtime schedules (static files only), stdio
  MCP (HTTP only). Found: every eve CLI command, `eve start` included, sends telemetry unless
  `EVE_TELEMETRY_DISABLED=1`; its store is 0755 plain JSON; 18 releases in 10 days, and a session only resumes on
  the eve version that started it (pinned exactly).
- **Companion** (`companion/`, own package and lockfile, Node 24+, bundled by esbuild into `dist/avi-brain.mjs`):
  127.0.0.1 only, Host check, pairing (one-time code from `avi-brain pair` → token; the Mac keeps its hash), Bearer +
  Origin on every `/v1` call, per-route rate limits, request-id dedupe, redacted JSON logs; Docker sandbox per agent
  profile through the Docker CLI (no network by default, CPU/memory/pids/time limits, no capabilities, read-only
  root, uid 1000, only its workspace mounted; clear "start Docker Desktop" message); `gh` read allowlist, posts
  only with the click and a secret scan, nothing that writes code; stdio MCP from `mcp.json` with tool fingerprints;
  routines on the Mac with the extension's own engine compiled in; artifacts frozen and served with
  `CSP: sandbox allow-scripts`, no network, through a one-time token in the Studio URL's fragment; eve started on a
  random loopback port with a per-boot secret, its agent resolving model/instructions/tools from Nex Brain;
  `scripts/install-launchagent.sh`.
- **Protocol** `src/shared/lib/protocol/companion.ts` (zod, Node-runnable): used by the extension, the companion and
  the E2E mock. **Found in Brave: the browser sends no `Origin` on an extension's GET** to a permitted host, so
  the API is POST/PUT/DELETE only.
- **Extension** `src/background/companion/`: `CompanionClient` (vault token, retry for reads only, breaker in
  `storage.session`, session follow with cursor reconnect, routines and artifact calls), `brain-settings` /
  `brain-status` stores for the shell, commands `brain_status|set_port|pair|unpair|check|artifacts|open_artifact`,
  job `brain_health` (every 2 min while paired), `registerStepExecutor('step.sandbox')` (health first: "not running"
  never becomes an unknown outcome; request id = run + step), `companionToolSource()` for Connectors.
  `src/side-panel/companion/`: Settings › Nex Brain (pair, status, Docker, engine, MCP, artifacts → Avi Studio).
  `step.sandbox` taken out of `NOT_YET_AVAILABLE` in `spec.ts` (one line). Locale keys `brain_*` (25).
- **Tests:** companion 60 unit + `pnpm test:eve` (13 checks, real eve, stdio MCP, approval relay, no secret on disk
  or in logs); extension 33 unit (protocol, client, executor, status); `e2e/companion.e2e.mjs` 3/3 in Brave (pair →
  connected with Origin + Bearer on every call and the token only in the vault; a routine's `step.sandbox` waits for
  the click then runs on the Mac and returns its output; an artifact opens in Avi Studio, the fragment token is
  spent and wiped, a remote image is blocked by CSP and never requested, opaque origin).
- **Needs Docker** (down while building): a real sandbox run, `pnpm sandbox:build`, an artifact build.
- **Needs the lead:** `import './companion/register';` in `src/side-panel/registers.ts` (the E2E needs it);
  `step.sandbox` in the authoring instructions (`authoring.ts`); routines "run on the Mac" sync in WS5a's service;
  WS4 to list `companionToolSource()`; WS5b to run agent sessions through `CompanionClient.createSession`.

### Wave 2 — Wave B integration (lead, 2026-10-12)

- **Merged** WS4 → WS5b → WS5c → WS8 → WS7 into `feat/restyle`, each with its wiring: connector tools in the
  agent's browser state (`connectorToolsSectionFor`) and in workflow authoring (`step.tool`, `step.sandbox`); a
  "Run a connector tool" kind on the confirm card; economy voice in `VoiceManager.start`, local voices in
  read-aloud and Voice output; Nex Brain settings in the panel.
- **Seams closed:** a connector tool that asks first now waits for the click in agent and routine chats too (the
  Inbox points to the waiting chat), instead of being refused; an agent's chat is kept to the agent's sites from the
  first step (`allowListFor` in `threads/factory.ts`), with one site parser (`siteHost`) shared with the agent's own
  check, and a firewall entry for one page never opens a whole site.
- **Security fixes from review:** tool fingerprints cover title and annotations (a server cannot quietly turn a tool
  "read-only"); tool listings show only plain names and go in as data; a connector's saved token or client secret
  never follows it to another server; on the Mac, network commands, GitHub posts and MCP writes need the click as
  relayed by the forwarder (`approved`), builds need `run_command` and never get network, and routine fetches connect
  only to the address they checked (`companion/src/workflows/publicFetch.ts`, against DNS rebinding).
- **Verified:** type-check, 1 052 unit tests, companion 65 tests, full E2E in Brave 87/87 (local voices included,
  with KittenTTS and Moonshine tiny installed by `scripts/voice-models-setup.mjs`).
- **Not wired yet:** routines "run on the Mac" (sync with Nex Brain), Nex Brain's MCP tools as a connector
  (`companionToolSource()`), agent sessions in Nex Brain's sandbox (`CompanionClient.createSession`), local
  speech-to-text for the chat box's dictation, deep links from an Inbox item to one workflow run.

### Dictation you can see (2026-10-12)

- The chat box's mic is a small state machine (`src/side-panel/hooks/useSpeechInput.ts`: idle → starting →
  listening → transcribing). While the mic is on, a strip takes the text box's place (`components/Dictation.tsx`):
  a red dot, a live level meter (an `AnalyserNode`, read on animation frames, no re-render per frame), the time, and
  an × that discards; the pill's edge turns to the recording colour, and the mic becomes a red stop button.
- **Stop** writes the words down and puts them after what was typed (it used to replace it). **Send while
  listening** (or while transcribing) sends the words as soon as they are written down. **Esc** discards. A failed
  or timed-out transcription (60 s) sends nothing and keeps what was typed.
- Transcription honours the Gemini provider's base URL (`createSpeechToTextModel`), as embeddings already did.
- Tests: `e2e/dictation.e2e.mjs` (fake microphone; the strip, meter and timer; Stop; Send while listening; a
  failure; Esc), unit tests for `meterLevel` and `joinWords`.

### Wake word: only on Ava (fixed 2026-10-12)

Bug: "hey" alone woke it ("hey there", "hey everyone", "hey, how are you", "hey, have a look at this" too).
Cause: the grammar `["hey ava", "[unk]"]` gives the decoder nowhere accurate to land but the full phrase, so
almost any "hey…" onset got forced into it.

Measured three options against 91 `say`-synthesized clips (Samantha, Daniel, Karen, Moira, Rishi, Aman, Tessa;
3 positive phrases incl. "Hey Ava, what's on my calendar today?" said in one breath, 10 negative — "Hey,
Eva's here" skipped as ambiguous per the brief) fed through the real Vosk worker in Brave — false wakes /
missed wakes out of 70 negatives / 21 positives:

| Option | False wakes | Missed wakes | Added latency |
| --- | --- | --- | --- |
| Today's grammar (baseline) | 15 | 0 | — |
| Competing-phrase grammar (`hey ava`/`hey`/`ava`/`[unk]`) live | 6 | 0 | — |
| Verify the candidate with a **free-form** decode | 0 | 18 | ~730 ms avg |
| **Verify the candidate with a grammar-constrained decode (chosen)** | **0** | **0** | **~260 ms avg, ~425 ms max** |

The free-form verifier missed almost everything because the small model (`vosk-model-small-en-us-0.15`) often
cannot say the name "Ava" at all when decoding freely, even on clean audio (empty or garbage text instead) —
it reliably manages it when a grammar can just offer the word. So the fix keeps today's grammar as the live
candidate detector (unchanged, still fires on any "hey…"), then decodes the candidate's phrase window (the
1.2 s ring from before it, plus 250 ms collected after, so a trailing "ava" completes) once more as a single
final result, on a second recogniser in the same worker, with `VERIFY_GRAMMAR = ["hey ava","hey","ava",
"[unk]"]`. Accepted only if the first two words are "hey"/"ava" (`heyAvaPrefix` — a prefix match, not exact:
the window can run a little past "ava" into the next word, which the grammar's own loop then tags as trailing
"[unk]", e.g. "hey ava [unk] [unk]" on the calendar sentence). No "eva"/"ever" weighing needed: neither word
is in this grammar's vocabulary, so the verifier cannot land on them by mistake. A rejected candidate resumes
listening at once, throttled 500 ms (`VERIFY_RETRY_MS`) so an ordinary sentence that starts with "hey" does
not re-trigger verification on almost every following chunk while it keeps going; a second candidate cannot
start verifying while one is already mid-decode (`deciding`), so the two can never have their worker replies
mixed up on the shared reply queue.

- `src/offscreen/wake.ts`: `VERIFY_GRAMMAR`, `VERIFY_TAIL_SECONDS`, `VERIFY_RETRY_MS`, `heyAvaPrefix`;
  `WakeListener` gains the verification sub-state (`verifying`, `deciding`) between a candidate and a wake,
  still on the same worker and model — nothing leaves the device at any point, and the conversation still gets
  exactly the phrase window plus what follows (`takeCapture`, unchanged).
- Lead's follow-up: what is said while the second decode runs (~260 ms) is kept for the conversation when the
  phrase is confirmed (it used to be dropped, which could clip the first word of a request said in one breath);
  a decode with no answer in 3 s rejects the candidate (`VERIFY_TIMEOUT_MS`), so the listener cannot get stuck;
  `stop()` resets verification. Unit tests drive the state machine on a stand-in worker (accept, reject, timeout,
  pause mid-decode).
- The fake-microphone E2E cannot reproduce the false wake: the old code did not wake on 79 s of seven synthetic
  voices saying "hey…" through Chrome's fake device either, so `e2e/wake-negative.e2e.mjs` is a guard against an
  over-eager change, not proof of the fix; the proof is the measurement above (direct feed to the real worker).
- Tests: `src/offscreen/__tests__/wake.test.ts` (+`heyAvaPrefix`, two cases); new `e2e/wake-negative.e2e.mjs`
  ("Hey.", "Hey there, how are you?", "Hey everyone, have a look at this.", "Okay, hey." looped never wake it —
  its own browser instance, since the fake microphone's file is fixed for the life of the Chrome process); `e2e/wake.e2e.mjs` unchanged and still green ("Hey Ava" wakes it with
  the panel closed); `e2e/voice.e2e.mjs` unaffected (its fake mic plays `hey-ava.wav` for VAD content with the
  wake listener off, never through this path) — 5/5. `e2e/fixtures/wake/hey-not-ava.wav` is the one fixture kept.

### Dropdowns above their siblings, and a "New"/"Add" button everywhere one was missing (2026-10-12)

- **Cards clipping open dropdowns.** `backdrop-filter` (`.glass`; the settings page's own `main .rounded-lg.border`)
  gives a card its own stacking context, so a child's z-index can never out-rank a *later* sibling card — the
  options page drew the "Add New Provider" list under the "Model Selection" card. Fixed globally, not just that
  list: a card that `:has()` an open `aria-expanded="true"` or `data-state="open"` descendant is lifted above its
  siblings (`src/ui/lib/theme.css`, shared by the panel, the settings page and the full-tab pages). Audited every
  absolutely-positioned dropdown/popover/menu in `src/options/**` and `src/side-panel/**`: the Radix `RowMenu`
  (Sidebar's row and profile menus, InboxRow) already escapes this through a portal; every other `absolute` element
  found was decorative (hover buttons, a badge, a toggle thumb), not a popover; `ModelSettings.tsx`'s provider
  selector was the one real instance. New E2E in `e2e/models.e2e.mjs` opens it and checks
  `document.elementFromPoint` at the overlap lands inside the list, not the card under it.
- **No way to start a workflow, agent or connector.** Each place that can create something now has a clear
  button at its top. **New workflow** / **New agent** (`WorkflowsPlace.tsx`, `AgentsPlace.tsx`) open a new chat
  with a starter already in the composer, focused: `create_workflow`/`create_agent` are chat-only actions with a
  confirm diff (wave2-plan.md), so this is the path that actually works today without bypassing that review — a
  by-hand "blank" editor would need a new background create command for each (`AgentEditor.tsx` today only
  updates an existing profile) and no such path exists for workflows at all. **Add connector**
  (`ConnectorsPlace.tsx`) reaches the existing `AddConnector` (catalogue + custom URL) from the top of the place,
  not only from the bottom of the catalogue list. `PanelApi` gained `startThread(prompt)`
  (`src/side-panel/registry.ts`; wired in `SidePanel.tsx` with a pending-prompt ref delivered once the new
  chat's composer mounts, since the composer isn't mounted while on another place). `Composer.tsx`'s `setContent`
  setter now also focuses the textarea (it only set the text before), which incidentally fixes focus for the
  Home screen's own starter buttons too. Checked Skills, Workspaces, Inbox sources, Knowledge and Meetings: each
  already has a working create affordance (Save page; + Add workspace; Take notes) or nothing to create (the
  watcher toggles under Inbox sources; Skills is taught after a task by design, per its own comment), so none
  needed a new button.
- New strings under `flow_`, `agents_`, `conn_` in all three locales; `node scripts/check-locales.mjs` passes
  (1424 keys × 3 locales).
- Tests: `pnpm type-check`; full `vitest run` (1069/1069, unaffected); touched-file lint (0 errors, only
  pre-existing warnings on lines not touched); in Brave — `models.e2e.mjs` 6/6 (incl. the new dropdown test),
  `shell.e2e.mjs` 3/3, `workflows.e2e.mjs` 2/2 (incl. New workflow), `agents.e2e.mjs` 2/2 (incl. New agent),
  `integrations.e2e.mjs` 11/11 (incl. Add connector).

### Rename: Avi Copilot → Nex Copilot, Avi Brain → Nex Brain (2026-10-13)

- Every user-visible string: manifest name/description (via `public/_locales/*`), all three locales, UI strings
  in `src/`, `site/src/content/site.ts`'s `PRODUCT`/`COMPANION` constants (and the OG images, regenerated by
  `pnpm build`), `site/public/install.sh` and `install.ps1`, `scripts/release.mjs`'s zip names, `companion/`'s
  README/SPIKE/CLI, and doc titles (README, PRIVACY, NOTICE, CLAUDE.md, docs/, `.agents/skills/`).
- `companion/` CLI: `nex-brain` is now primary (`bin.nex-brain` in `package.json`, built to
  `dist/nex-brain.mjs`); `avi-brain` stays as an alias pointing at the same built file. Help text, pairing
  prompts and error messages now say `nex-brain` / Nex Brain / Nex Copilot.
- `install.sh`/`install.ps1`: `NEX_COPILOT_BASE_URL` is now the primary env var; the old `AVI_COPILOT_BASE_URL`
  is still read as a fallback. The install-folder marker file is now `nex-copilot-install.txt`; the installer
  still recognizes the old `avi-copilot-install.txt` on an existing install, so update/uninstall keep working
  on a folder the old installer made. Default install folder is now "Nex Copilot" (macOS) / `nex-copilot`
  (Linux) / "Nex Copilot" (Windows, `%LOCALAPPDATA%`) — an install made under the old default path is not
  auto-discovered; the user would re-run with `--dir` pointing at the old location, or reinstall.
  `scripts/release.mjs` now writes `nex-copilot-<version>.zip` / `nex-copilot-latest.zip`.
  Verified end to end against a local `python3 -m http.server`: install, update (same folder, marker
  recognized), uninstall, and an old-marker folder correctly recognized and updated in place.
- `SITE_URL` default (site/astro.config.mjs) and `site/src/content/site.ts`'s `links.releases` now point at
  `https://nex-copilot-one.vercel.app`.
- Narration audio: checked `site/src/content/narration.json` for "Avi" (case-insensitive, excluding "Ava", the
  in-app assistant's own name, which is untouched) — no hits, so no clip needed re-recording.
- Kept unchanged, as internal identifiers that would lose data or break pairing/updates if renamed: IndexedDB
  names (`avi-copilot`, `avi-secrets`, `avi-vault`), the vault's file marker `source: avi-copilot`
  (`src/side-panel/vault/markdown.ts`'s `MARKER`, written into existing exported notes), `VITE_SEED_PROFILE=avi`,
  the manifest `key`/extension ID, the companion's macOS `~/Library/Application Support/Avi Brain` data
  directory and `~/Library/Logs/Avi Brain` (and the `com.avicopilot.brain` LaunchAgent label that points at
  them), the companion's Keychain service name (`src/workflows/keys.ts`'s `SERVICE`), Docker image tag/labels
  and container-name prefixes, the `AVI_BRAIN_*` env vars, and the companion's internal `avi-brain.ts` lib
  filename/MCP-client/eve-channel identifiers. `EXPORT_ROOT` (the Obsidian folder name shown to the user) was
  renamed to "Nex Copilot" since the locale text describing it changed too; `companion/spike/` (an unshipped
  experiment) was left alone.
- "Avi Studio" (the companion's artifacts viewer) is a separate feature name, not in scope for this rename, and
  was left as is.
- Site: audited every feature shown against `docs/task.md`'s "Not wired yet" list and `docs/distribution.md`.
  Existing badges already matched reality (Local voices "Optional", Nex Brain "Optional · macOS · coming soon",
  whose installer is genuinely not public yet). Fixed one stale badge: the Windows install tab said "Script
  coming" even though `install.ps1` has existed for a while (just never run on a real Windows box per
  `docs/distribution.md`) — changed to "Sneak peek" with a note explaining it is unverified.
- Tests: root `pnpm type-check`, full `vitest run` (1069/1069), touched-file lint (0 errors, only pre-existing
  warnings), `node scripts/check-locales.mjs` (3 locales, 1425 keys each), `pnpm build`; in Brave —
  `shell.e2e.mjs` 3/3, `models.e2e.mjs` 6/6, `agents.e2e.mjs`+`kb.e2e.mjs`+`workflows.e2e.mjs` 11/11,
  `meeting.e2e.mjs`+`companion.e2e.mjs` 9/9. Companion: `pnpm install --frozen-lockfile`, `pnpm test` (65/65),
  `pnpm type-check`, `pnpm build` (produces `dist/nex-brain.mjs`), manual `node dist/nex-brain.mjs status`.
  Site: `pnpm typecheck`, `pnpm build` (OG images regenerated), `scripts/verify.mjs` in Brave (no stop-ship
  conditions; screenshots read).
- `grep -rn "Avi Copilot\|Avi Brain"` (excluding `node_modules`, `.claude`, `companion/spike`) leaves only the
  internal identifiers listed above, plus the `install.sh`/`install.ps1` comments naming the old env var and
  marker for backward compatibility.

### First-run setup and the assistant's name (2026-10-13)

- **Setting:** `assistantName` in the general settings, default "Ava". `src/storage/lib/settings/assistant.ts` checks
  it (trimmed, 1–24 characters, letters of any script, spaces, hyphens, apostrophes; an invalid stored value reads as
  Ava) and holds `onboardingStore` (`onboarding.completedAt`, its own key, so installs from before it see the setup
  once too). Changeable later in Settings › General › Assistant name.
- **Setup** (`src/side-panel/onboarding`): an overlay on first open of the panel, three steps — name (prefilled Ava),
  add a model (opens the Models & usage place, parking the setup behind a "Finish setup" pill), wake word (optional
  switch, says what it listens for). Skip and Esc end it at any step; Enter goes on; Tab stays inside. Strings
  `onboard_*` in all three locales.
- **Where the name shows:** home (mono label above the greeting, the orb's label), the welcome screen's orb, the voice
  screen's label, the header's "Talk to <name>", "<name> is thinking" in a run and in meeting Q&A, the read-aloud
  tooltip, the click-to-allow notice ("<name> wants to …"), the wake-failure notification. Prompts: the navigator and
  planner get a short "YOUR NAME" section (`buildIdentitySection`), and the voice instructions start "You are
  <name>". Strings that said "Hey Ava" (`settings_wake*`, `help_*`) take the actual phrase as a placeholder.
- **Wake phrase:** "hey <name>" only when every word of the name is in the Vosk model's vocabulary, else "hey ava"
  with a note in setup and Settings. Vosk does not report unknown grammar words to the page: it logs
  `Ignoring word missing in vocabulary: 'zorblax'` and drops the word (checked in Brave against `hey-ava.wav`:
  `["hey zorblax","[unk]"]` decodes as `hey [unk] [unk]`), which would make plain "hey" wake it. So
  `scripts/wake-word-setup.mjs` now also writes `public/wake/words.txt` (152,211 words, 1.3 MB, read from the
  symbol table inside the model's `graph/Gr.fst`); `node scripts/wake-word-setup.mjs --words` writes only that file
  from a model already in place. Without the file, any name other than Ava keeps "hey ava". The background passes
  the words to the offscreen listener (`wake_start {words}`), restarts it when the name changes, and the
  verification decode uses `["hey <name>", "hey", "<name>", "[unk]"]` and checks "hey" then every word. The
  precision measurements above are for "hey ava" only; a custom name has not been measured.
- **E2E:** the harness marks setup done by default; `launchExtension(mock, { onboarding: true })` opts out
  (`e2e/onboarding.e2e.mjs`). The voice tests' "Talk to the copilot" is now "Talk to Ava".
- Tests: `pnpm type-check`; full `vitest run` (new: `settings/__tests__/assistant.test.ts`, custom-phrase cases in
  `offscreen/__tests__/wake.test.ts`, identity section in `prompts/__tests__/style.test.ts`); touched-file lint (0
  errors); `check-locales` passes; full E2E in Brave 98/98, including `wake` and `wake-negative`.

### Bring in your AI history (sneak peek, 2026-10-14)

- **Import** (`src/side-panel/history/reader.ts`, Settings › Bring in your AI history): the user picks a folder
  (File System Access, read only, kept in IndexedDB `avi-history`; "Allow again" after a restart). Files are recognised
  by path (`background/history/parse/detect.ts`): Claude Code `projects/*/<uuid>.jsonl`, Codex `rollout-*.jsonl`,
  Gemini CLI `tmp/*/chats/session-*.json`, `logs.json`, checkpoints, VS Code `chatSessions/*.json(l)` (+
  `workspace.json` for the project), and ChatGPT / Claude.ai `conversations.json`, loose or inside an export zip
  (read with `DecompressionStream`, no library). Only user and assistant text is kept (no tool calls, results,
  thinking, meta or reminder wrappers); turns are capped at 4,000 characters and conversations at 40,000 (opening and
  latest turns). JSONL is streamed line by line. Incremental: per file path + size + mtime in the panel, per
  conversation `sourceUpdatedAt` in the background. Caps per pass: 20,000 files, 5,000 conversations, 2 GB (newest
  first). Progress and Cancel. Checked against the real Claude Code, Codex and VS Code files on the owner's Mac
  (shape only); Gemini CLI and the exports follow the published formats (none on this Mac). Cursor and Windsurf keep
  chats in SQLite: not supported. Chrome will not open `~/Library`, so VS Code history needs a copy.
- **Safety**: `history/redact.ts` (the companion's secret rules, widened: PEM blocks, bearer tokens, URL passwords,
  `NAME=value` secrets) runs in the panel before sending and again in the background (`history/importer.ts`, zod
  schema per batch). Summaries and the agent see imported text only through `wrapUntrustedContent`. The graph builder
  makes no model call for `ai-session` items. No new permissions or hosts.
- **Storage and routing**: `ai-session` knowledge items (`sourceId` `<tool>:<id>`, `origin {tool, project,
  importId}`), so search, citations, the graph and the Obsidian export (`AI sessions/`) see them. `history/route.ts`:
  the user's project-folder mapping (or a parent's) → a workspace named by the folder path (home folder name ignored)
  → `routeWorkspace` on title + first request → none. Mapping a folder moves its sessions
  (`KnowledgeBase.setWorkspace`). Bookkeeping, mappings and summaries in `storage.local` `ai-history`.
- **Summaries** (`history/summaries.ts`, prompt in `summary-prompt.ts`, pure parts in `rollup.ts`): per workspace a
  "where we are" (recent work, decisions, open threads, next actions with dates, cited) from that workspace's items
  only, rebuilt when their fingerprint changes; job `workspace_summaries` after each import and daily at 07:30; plain
  list when no model. Knowledge base › Where we are shows one workspace's summary, or with "All workspaces" the
  roll-up (latest activity, this week's count, next actions). The morning brief adds the roll-up.
- **Agent**: `workspace_context` (registered action) returns the task's workspace summary plus matching passages from
  that workspace only, or the roll-up outside a workspace; the workspace section tells the agent to use it for
  "summarize" / "where are we at".
- Also: Knowledge base's "Save this page" is an icon button now, so four tabs fit at 400 px; kb export/import keeps
  `workspaceId` (it was dropped before).
- Tests: `history/__tests__` (parsers on synthetic fixtures, zip, caps, redaction, routing, workspace-scoped prompt,
  roll-up, incremental import); `e2e/history.e2e.mjs` (5: import + routing + redaction + re-read, scoped summaries +
  roll-up UI, agent action, brief, forget); `kb` and `graph` E2E still pass.

### Ava in WhatsApp Web, plan A (sneak peek, 2026-10-14)

Ava works inside the user's own signed-in WhatsApp Web tab. No unofficial libraries, no API. Plan B (her own number on
the Cloud API) is `docs/whatsapp-plan-b.md`.

- **Site knowledge in a skill:** built-in `whatsapp-web.md` holds the tips for the agent and a ```` ```selectors ````
  block (`key: css || css`). `src/background/whatsapp/selectors.ts` reads it (the user's edited copy over the
  built-in, key by key), so a WhatsApp redesign is fixed by editing the skill. The page functions in
  `whatsapp/page.ts` are self-contained and take the selectors as an argument.
- **Catch-up and drafts** (`whatsapp/actions.ts`, registered agent actions): `whatsapp_unread` reads unread chats
  from the chat list without opening them; `whatsapp_read_chat` opens one by search; `whatsapp_draft_reply` opens the
  chat, types the reply into the message box and then goes through `reviewAction` as Enter in the box (kind `send`),
  so the card shows the exact text and nothing goes out before the click. Declining leaves the draft in the box.
  Everything read is `wrapUntrustedContent`. Inbox › WhatsApp › Catch up ("What did I miss?", "Draft a reply" on each
  WhatsApp item, and on an item's detail) hands a prompt to a new chat.
- **Bulk message** (Inbox › WhatsApp › Bulk message, marked "Sneak peek"): paste or import a CSV (quotes, commas,
  BOM, `;`/tab), a template with `{{name}}`/`{{column}}`, one optional attachment (≤ 5 MB, pasted into the chat with
  the message as caption), numbers not in the contacts via `web.whatsapp.com/send?phone=`. Pure parts in
  `src/storage/lib/whatsapp/` (`csv.ts`, `bulk.ts`: render, phone normalisation, dedupe, opt-out column, pacing,
  daily cap). The review lists every recipient with its rendered message or why it is skipped, plus the ban warning;
  approval is one HoldButton (hold or click twice) answered with the batch's `approvalId` from the panel only
  (`wa_bulk_answer`): no agent action, routine or timer can start a batch, and the gate settings cannot turn it off.
  Limits: random 8–20 s between messages, a 2–5 min cooldown every 10, daily cap 50 (user-set, clamped to 1–200 on
  every read), at most 500 rows and one open batch at a time.
- **Run** (`whatsapp/bulk/`): runs live in `storage.local` (`whatsapp-bulk-runs`; no new Dexie table), changed one at
  a time (`state.ts`). `runner.ts#advanceRun` sends one message at a time, waits up to 20 s inline and schedules a job
  (`whatsapp_bulk`, one key per continuation) for anything longer. A message is marked `sending` before the click; if
  the background stops mid-send, it becomes `failed / unknown_outcome` with an Inbox alert and is never sent again. A
  closed or signed-out tab pauses the run (`waiting_tab`) with an Inbox note; the daily cap pauses it until the next
  local day. Pause/resume/stop at any time; the report (sent/failed/skipped with reasons) exports as CSV.
- **Tests:** unit `storage/lib/whatsapp/__tests__/bulk.test.ts` (CSV, template, phones, dedupe/opt-out, pacing with
  a fake random source, cap, clamping), `background/whatsapp/__tests__/runner.test.ts` (fake clock: inline gap vs.
  job cooldown, no early send, daily cap and next-day resume, pause, closed tab, a rejected number, no resend after
  an interrupted send), `selectors.test.ts`. E2E `e2e/whatsapp.e2e.mjs` against `e2e/fixtures/whatsapp/web.html`
  served by interception: catch-up, a draft that waits for the click, a 3-recipient batch that sends only after the
  approval (dedupe and opt-out skipped), pause/resume with an invalid number skipped, and stop.
- **Not done:** the agent's own skill section includes the selectors block (about 1.5 k characters per step on
  WhatsApp pages); a resume after a closed tab is manual; attachments are only covered by code, not by E2E;
  real-WhatsApp behaviour (Lexical composer, `/send` reload times) is untested here by design.

### One conversation, typed or spoken; pictures and video; Ava reads other chats (2026-10-14)

- **Keyboard opens the same conversation.** `voice_status` (offscreen) and `voice_started` carry the voice thread id;
  a panel that opens mid-conversation asks `voice_state`. The voice screen's Keyboard button hides the overlay and opens
  that thread (`VoiceThreadBar`: "Ava is listening…", **Back to voice**, and chips for the tasks Ava started from it,
  linked by the new optional `ThreadRecord.voiceThreadId`). While the conversation is on, a message typed there is
  `voice_text` → `VoiceManager.sendText` (kept in the thread with its attachments) → offscreen `voice_text`: Live gets
  one `clientContent` user turn (note + `inlineData` pictures + words, `typedTurn` in `offscreen/voice.ts`); economy
  queues it as a typed turn (`EconomySession.sendText`, images as file parts, a model that refuses them answers the
  words and says it cannot see). The answer is spoken and written to the thread by the usual `onTurn`. When no
  conversation is on, the voice thread is a normal chat.
- **Pictures and short videos in any chat.** Composer takes png/jpg/webp/gif ≤ 10 MB and mp4/webm/mov ≤ 50 MB / 60 s
  (limits and `framePlan` in `storage/lib/threads/attachments.ts`), with removable thumbnails. The panel reads them
  (`side-panel/attachments/media.ts`): images scaled to 2048 px when big (GIFs as their first frame), videos sampled
  with `<video>`+canvas at one frame / 2 s, max 16, and their sound decoded to 16 kHz WAV only when a speech model is
  set. The background re-checks everything (`background/threads/attachments.ts`, zod), transcribes the sound with the
  speech model, and keeps blobs on the message (`ThreadMessage.attachments`: image, or a video's frames + transcript;
  no Dexie schema change). The agent gets them as image parts after a note that they are content, never
  instructions (`MessageManager` task/follow-up messages; retry re-sends them). A model that cannot see (catalog
  modalities, else `tagsFromName`) gets the words only and the chat says so (`chat_attach_noVision`). Media only
  goes to the configured model / speech provider.
- **Ava checks other conversations.** `search_chats` (query, optional workspace; titles + messages, workspace first,
  every-word matches first, newest first; ids/titles/dates/snippets) and `read_chat` (id → last N, older part
  summarised past 6,000 chars) as voice tools and agent actions (`background/chats`), results wrapped untrusted;
  results from outside the asking workspace are labelled. Voice instructions and `voice.e2e.mjs`'s tool list updated.
- Tests: unit (limits, frame plan, WAV, ranking/snippets/read, wire checks + model note, task image parts, typed Live
  turn, economy typed turn); `e2e/voice-thread.e2e.mjs` (keyboard opens the voice thread, typed text and a picture
  reach the same Live session, `search_chats` finds an earlier chat, pictures reach the mock navigator as image
  parts, a blind model is refused plainly).
- Known gaps: pictures from earlier turns are not re-sent to a new executor (only the turn they came with); a tool
  that needs spoken words (leave/end call) still refuses a typed request; video is not E2E-tested.

### Personalities (2026-10-14)

- A personality is a name, description, emoji, instructions (≤2,000 chars), and an optional voice and pace
  (`src/storage/lib/personalities`, key `personalities` in storage.local). Six built-ins, read-only: Default, Cracked
  engineer, Accountant, Legal eye (always "Not legal advice…"), Strict auntie (never insulting), Bezos-style operator
  ("inspired by" his public principles; never claims to be him). Users create, duplicate, edit and delete their own
  (≤30).
- Which one applies: a workspace's own default for its chats, otherwise the active one. Switching inside a workspace
  that has a default changes that default; anywhere else it changes the active one (`withActive`).
- Where it reaches the models: planner and navigator (`buildPersonalitySection`, after the gate/reader/knowledge/style
  sections, inside `<system_instructions>`), the voice conversation (`voiceSessionInstructions`, after the rules,
  before history), the morning brief's priorities (tone line only). Every section says it cannot override the rules.
  The executor gets it from `threads/factory.ts` (the thread's workspace); a switch applies from the next run.
- Voice and pace: read-aloud (`tts/speak.ts`) and economy voice use the personality's voice (a system voice for the
  system engine, a Kitten/Kokoro id for its own engine) and pace; Gemini Live keeps its own voice.
- Switching: header picker next to the orb (Radix menu), Settings › Personalities (list, use, duplicate, edit,
  delete, per-workspace default), voice tool `set_personality` (free, like `end_conversation`), agent action
  `set_personality` (refused in agent/routine/brief runs). Home shows "Ava · 🧾 Accountant".
- Tests: unit (validation, resolution, switching, matching, voice/pace, prompt order in planner/navigator/voice);
  `e2e/personalities.e2e.mjs` (header switch → next request carries it, below the gate; custom one from Settings),
  `voice.e2e.mjs` (`set_personality` with no click; next session's instructions carry it).

### Quiet extension errors, and choosing a mic/speaker (2026-10-14)

- **Quiet `brave://extensions` errors.** `injectBuildDomTreeScripts`/`scriptInjectedFrames`
  (`background/browser/dom/service.ts`) now recognise the four chrome.scripting race messages for a tab or frame
  that is already gone (`No tab with id`, `No frame with id`, `Frame with ID … was removed`, `The tab was closed`) and
  log those at `debug` (silent in production) instead of `console.error`; anything else still logs as a real error, and
  nothing is retried into a gone target. The wake word's Vosk worker (`src/offscreen/wake.ts`, and the plain-dictation
  recogniser in `src/offscreen/stt/vosk.ts`, same worker/model) now sends `{action:'set', key:'logLevel', value:-1}`
  right after creating the worker, before `'load'`: the worker defers its native `SetLogLevel` call to load time, so
  this silences the "LOG (VoskAPI:…)" startup chatter (otherwise printed as console warnings) without touching the
  generated `public/wake/vosk-worker.js`.
- **Choose the microphone and the speaker.** New Settings › Audio devices section (`side-panel/audio-devices`,
  registered right after Voice engines) lists `navigator.mediaDevices.enumerateDevices()` audioinput/audiooutput
  devices with labels, plus "System default"; the list updates live on the panel's own `devicechange` event. A
  choice is kept by deviceId **and** label (`storage/lib/settings/audioDeviceSettings.ts`): matched by id first,
  falling back to the label when the id was reassigned between sessions (deviceIds are not stable; labels are) —
  the matching/fallback/disconnect logic lives in `src/shared/lib/audio-devices` (`resolveAudioDevice`,
  `requestMicStream`, `setAudioSinkId`), framework-free and unit-tested. Only the offscreen document has microphone
  permission, so it is the one place that can read device labels (`src/offscreen/devices.ts`); the panel has no
  storage access to it either way, so it asks over the usual command channel
  (`background/audio-devices/register.ts` → `audio_devices_list`, opening the offscreen document only for the ask).
  **The offscreen document itself does not import `@extension/storage`** — doing so changed its Vite chunk graph
  (a new shared `base-*.js` chunk split out) in a way that silently broke `chrome.runtime.onMessage` delivery to it
  in testing (every offscreen-backed feature — wake, voice, recorder — timed out with "Receiving end does not
  exist", found by bisecting the regression against a clean worktree). Instead, the background reads
  `audioDeviceSettingsStore` and pushes the choice over as a plain message, `audio_devices_apply`: once right after
  `ensureOffscreen()` creates a fresh document (`background/offscreen.ts`), and again on every later change, but only
  to a document that is already open (`background/audio-devices/register.ts` subscribes to the store). The offscreen
  document keeps the pushed values in two module-level variables and applies them to whatever is running
  (`WakeListener.switchMic`, `VoiceSession.switchMic`/`switchSpeaker`, `LocalTts.setOutputDevice`,
  `TtsPlayer.setOutputDevice`) and to anything it starts afterwards (wake, Live/economy voice, meeting recorder,
  cloud TTS playback) — `getUserMedia({ deviceId: { exact } })` with a fallback to the system default on
  OverconstrainedError/NotFoundError, `setSinkId` for playback where supported. Dictation
  (`side-panel/hooks/useSpeechInput.ts`) reads the store directly (the panel has no such chunking issue) and applies
  the same fallback. `chrome.tts` (system voices) cannot choose an output device, so the speaker select says so next
  to it when the TTS engine is `system`.
- Tests: unit (`src/shared/lib/audio-devices`: id/label/disconnect resolution, mic constraints, getUserMedia
  fallback, setSinkId; `storage/lib/settings/audioDeviceSettings`; `background/browser/dom/service` for the gone-tab
  race classifier). E2E: confirmed with Chrome's fake devices (`E2E_FAKE_MIC`) that the selects list all fake
  devices with labels, a choice persists and is applied (checked via the background's raw command reply and the
  rendered `<select>`), and re-ran `wake`, `voice`, `voice-engines`, `dictation`, `meeting` and `threads` E2E (all
  green) after the chunking regression above was found and fixed.
- Known gaps: mid-session mic/speaker switching is wired for wake listening and the Live/economy voice session, but
  not for an in-progress meeting recording (a new recording picks up the current choice; changing it mid-recording
  does not restart the mic track) or for a dictation recording already in progress (same: applies to the next one).
  No dedicated E2E for the live-switch path (`audio_devices_apply` arriving mid-conversation) or for the
  disconnect→reconnect UI text, though both are covered at the unit level.

### Ava's identity, memory, and voice as the hub (2026-10-15)

Design and sources (Letta, Generative Agents, Mem0/Zep): `docs/ava-identity.md`.

- **Core identity** (`background/identity/prompt.ts`, store `ava-core`): character, values, purpose/ambitions, the
  name rule (corrects another name lightly once, never takes one on) and banned generic openers, in the planner,
  navigator (after the gate/reader/knowledge sections, before style and personality), voice (after its rules),
  brief and workspace summaries. Settings › Personalities › "Ava's core" edits it; reset to default.
- **About you** (store `about-you`, `src/storage/lib/identity`): dated facts with source and earlier wordings, goals,
  insights. `remember` / `update_memory` as voice tools and chat actions; only the user's own words make a fact
  active, anything else is "proposed" until confirmed in Settings › About you; agent/routine/brief runs write none.
- **Reflection**: job `identity_reflect` daily 07:45 and after a 12+ turn voice conversation; insights and per-workspace
  goals from recent chats, voice, meetings and summaries (untrusted), never facts. The brief shows "Your goals".
- **Voice hub**: `read_screen` (text + `captureVisibleTab` JPEG as a Live video frame), `do_task`, `create_workflow`,
  `update_workflow`, `where_are_we`, `change_setting` (spoken yes required); instructions say never "I can't see
  your screen".
- **Meeting links**: template + `step.meeting_join` (side effect, waits for Allow); tab triggers now fire
  (`WorkflowService.fireTab`); Meet pattern narrowed to `meet.google.com/*-*-*`.
- **Fixed voice/language**: Settings › Voice and language (store `voice-identity`); `speechConfig.voiceName` always,
  `languageCode` only for half-cascade models (native-audio models do not support it) plus a firm language line.
- Tests: unit (`identity/__tests__`, `storage/lib/identity/__tests__`, `workflows/__tests__/tab-trigger.test.ts`,
  `offscreen/__tests__/speech.test.ts`); E2E `e2e/identity.e2e.mjs` (5) in Brave; `voice`, `voice-thread`,
  `personalities`, `workflows`, `meeting`, `history`, `agent` E2E green.
- Known gaps: economy voice cannot look at the screenshot (text only); chat threads do not trigger a reflection on
  their own (daily and voice only); Zoom/Teams joining relies on their web clients and auto-notes, untested on the
  real sites; the language code list for half-cascade models is by name, not checked against the API.

### Meeting notes start on join, and never fail silently (2026-10-16)

Owner's report: the "what is this call about?" window opened behind the browser on every join, and two meetings
that day were not recorded without anyone noticing.

- **Root cause.** Auto-notes (`meetings/autojoin.ts`) never waited for that window, but they could never record
  audio either: Chrome hands a tab's audio over only after the user invokes the extension on that tab, so a joined
  call always fell back to reading Meet's captions. If captions did not arrive (turned off, or Meet's caption DOM
  not matching `CAPTION_SELECTORS`), nothing was taken down and nothing said so; a start error went only to the
  log. The window itself was a `chrome.windows.create` popup, which macOS/Brave puts behind a full-screen or
  focused call window, so the one visible sign looked like a gate. Two more holes: the toast told the user to press
  Alt+Shift+M "to add audio", but that shortcut *stopped* a running meeting; and a captions meeting never ended when
  the user left the call, so the next call was skipped as "already recording".
- **Now** (`meetings/join-flow.ts`, a small state machine with its effects injected): join → notes start at once
  (audio if the tab was invoked, else captions); a calendar match sets the topic; otherwise the optional note is
  asked in the side panel (`side-panel/meetings/AutoNotesCard.tsx`, at the top of every view) and as an Inbox item,
  with a quiet notification. No popup window any more (`meeting-ask.html` is unused; delete with approval). Answering
  calls `meeting_add_note` → `setTopic(…, 'user')` (up to 500 chars) and marks the Inbox item done; ignoring it
  changes nothing.
- **Loud failures** (`meetings/alerts.ts`): a start failure, captions-only notes with nothing caught after
  `nothingCapturedSeconds` (90 s), or a recorder error → a notification that stays until dismissed, an Inbox alert,
  and Ava says it when a conversation is on. The `nothing_captured` warning shows in the card and the meeting view.
- **Audio, reliably.** The toolbar click (or Alt+Shift+M) on the call is the invocation Chrome needs: it now upgrades
  a captions-only meeting to audio on the same timeline (`MeetingManager.addAudio`, recorder `offsetSeconds`); the
  card's "Record audio" does the same when the tab was invoked earlier (the grant lasts until the tab navigates).
  Nothing can grant it without a user action on the tab, so the card, the toast and the alert all say where to click.
- **Leaving ends notes**: the call tab moving off the call, or its Leave button gone for three checks (~90 s).
- Tests: `meetings/__tests__/join-flow.test.ts` (8: join records without an answer, calendar topic, note added and
  empty note ignored, start failure alerts, a failing alert keeps the recording, nothing-captured alerts once, quiet
  when captions or audio arrive, recorder failure only while recording). E2E in Brave, `e2e/meeting.e2e.mjs` +2 on
  an intercepted Meet call: joining records with no answer, no popup, the card/Inbox/notification show, captions
  arrive, the note attaches; a call with nothing to capture raises the alert (Inbox, notification, panel) and the
  toolbar click turns it into an audio recording. `meeting` 8/8, `voice` 6/6, `calendar` 1/1.
- Not covered: Meet's real caption DOM is unverified against today's Meet (the alert now makes a mismatch visible);
  leave detection has no automated test (it needs 90 s of alarms); there is still no "ask before recording" setting:
  Auto-notes on (the default) records, off does nothing.

### Ava as the master interface (2026-10-16)

- **Capability list that can't drift** (`src/background/capabilities/catalog.ts`, `sources.ts`): built at call time
  from the core `VOICE_TOOLS`, every `registerVoiceTool`, the navigator's own action schemas plus every
  `registerAgentAction` (new `registeredActionSchemas()` in the registry), and the panel's places and Settings
  sections, which the panel reports at start (`side-panel/capabilities/register.ts` → `capabilities_panel`, kept in
  storage.local `capabilities-panel` so Ava knows them with the panel closed). Only the group a tool goes under is kept
  by hand (`TOOL_GROUPS`); an unknown tool lands in "More", never nowhere, and a unit test scans the background for
  `registerVoiceTool` names without a group. A compact version goes in the voice setup (after the rules) and in the
  navigator's prompt (the action's `prompt` is a getter); `what_can_you_do` (voice tool, free like `stop_tasks`, and
  chat action) returns the full grouped list. Command `capabilities_list` returns names, text and the tab line.
- **Panel audit → new tools**: `open_place` (any place, Settings section — scrolled to and focused — or the chat of a
  waiting card; with the panel closed it waits in storage.session until the panel opens, since an extension can't open
  its own side panel without a click), `start_meeting_notes` / `stop_meeting_notes` (meeting manager),
  `read_confirm_cards` (cards and Inbox approvals read aloud, wrapped untrusted; answering stays the click),
  `manage_inbox` (done/read/snooze through the Inbox's own commands; approvals refused), `list_connectors`,
  `list_workspaces`, `list_personalities`. Chat actions: `what_can_you_do`, `open_place`, `check_audio`,
  `check_model`. Still panel-only on purpose: adding/signing in/enabling connectors, creating/editing workspaces and
  personalities, answering approvals and confirm cards.
- **Diagnostics, rules only**: `check_audio` (`audio-check.ts` + `src/offscreen/audio-check.ts`): the chosen
  mic/speaker labels, the mic's RMS over 2 s in 100 ms slices (no echo cancellation/AGC) judged silent < 0.002 peak,
  quiet < 0.02, else "I can hear you", plus a 0.7 s two-note tone via `setSinkId` and "ask whether they heard it".
  `check_model` (`model-check.ts` rules, `probes.ts` pings): a 16-token request to the chat (navigator) and
  speech-to-text models, a Live socket setup (skipped with a note while a Live conversation runs on it; economy mode
  noted), errors classified (rate limit, key, unreachable, timeout), slow > 8 s (Live 6 s); alternatives from
  configured providers, the catalog, health and open breakers. Rate limit/key → another cloud provider first; down/
  slow → a running local model first; Live → economy voice. `switch_model` applies only a switch check_model just
  recommended, and only when the user's latest words say yes (`spokenYes`, as `change_setting`); chat moves the
  navigator (and the planner when it was on the failing provider), speech moves the speech-to-text model.
- **Tab awareness** (`tabs.ts`, `instance.ts`): `TabTracker` follows `tabs.onActivated/onUpdated/onRemoved` and
  `windows.onFocusChanged` (only the focused window counts; private tabs are "a private tab"; persisted in
  storage.session). On a switch or title change (settled 400 ms) a running Live conversation gets
  "System context (no reply needed): The user's tab in front: … (previous: …)" as `clientContent` with
  `turnComplete: false` (`VoiceSession.addContext`, held while she speaks); economy turns get the line in their
  instructions; the voice setup and the navigator prompt start with it. `read_screen`/`read_page` default to the tab
  in front, else the last tab Ava worked on (`targetTab`); no click, but the wake-word guard still applies.
- Voice instructions: never "I can't" for anything on the list; call `what_can_you_do`; say the tool in a few words.
- Tests: unit `capabilities/__tests__` (catalog: every tool once, unknown → More, every registered voice tool has a
  group, place matching; audio verdicts from fake levels; error classes and switch rules; tracker switch/previous/
  private/fallback), `offscreen/__tests__/typed.test.ts` (context turn). E2E `e2e/ava-hub.e2e.mjs` (4) in Brave:
  `what_can_you_do` lists tools and the panel's places, switching tabs reaches Live as quiet context with no confirm,
  `check_audio` hears the fake mic, `open_place` focuses Settings › Audio devices. `voice` (tool list updated),
  `voice-thread`, `identity`, `personalities`, `agent`, `wake`, `voice-engines` green.
- Known gaps: the navigator's tab line is read when its prompt is built (per task), not per step; recent model
  failures come from the registry's health and breakers, not a per-call failure log (the usage meter records no
  errors); `check_model` does not ping the TTS engine; `open_place` cannot open a closed panel.

### Workflows audit (2026-10-16)

"Workflows don't work properly": every way in (chat, New workflow, both templates, voice), the diagram and inspector,
each trigger and step kind, approvals, cancel, retries, budgets and a service-worker restart were driven in Brave
against the mocks. Broken → fixed, by impact:
- **An unanswered approval stopped the routine for good.** The open run blocked every later firing: after one ignored
  "join this meeting?" offer, Meeting links never offered again; a scheduled routine skipped every later time. Now a
  new firing (schedule, event, tab) replaces a run that only waits for an approval (cancelled "a newer run took its
  place", its Inbox item settled). A browser task waiting in its chat is work under way and is kept.
  (`service.ts` `blockingRun`, `engine.cancel(runId, message)`)
- **Hand edits looked undone.** After any run the diagram and inspector showed that run's version, so a new schedule,
  name or instruction saved in the inspector reverted on screen (the header said 08:00, the card 07:30). The diagram
  now shows what runs now; the latest run lights it when it ran this version or one with the same steps; an older
  version shows only when picked in the history ("an earlier version", read-only). (`WorkflowDetail.tsx`)
- **Steps that could not run asked for a click first.** A sandbox step without Nex Brain, an agent step naming no
  such agent and a tool step without its connector waited for "Hold to allow" and failed only after it. A new
  `StepExecutor.check` runs before the approval (`prechecks.ts`, merged in `executorFor`): "This step runs code in
  Nex Brain … Pair it in Settings › Nex Brain"; "There is no agent "X"; your agents: …"; the connector's own refusal
  ("This routine is in no workspace …" instead of "This chat …"). Sandbox cards say "Needs Nex Brain" while unpaired.
- **A restart marked a handed-off side effect unknown.** An agent step (a side effect) parked on its agent's run was
  marked "may or may not have happened" after a service-worker restart, and any parked run more than 15 minutes old
  was closed as interrupted. A step with saved state whose executor is resumable now carries on. (`engine.recover`)
- **Meeting links was unreadable in the panel**: five triggers in one row, zoomed to 32 %. The diagram picks left to
  right when that fits the box clearly better (now 74 %). (`diagram.ts` `box`, handles follow the direction)
- **Tab and event routines read "By hand"** in the list and header; runs from a tab said "by hand". Now "When one of 5
  kinds of page opens", "When a meeting ends", "by an open page". (`meta.ts` `triggerSummary`)
- **"New workflow" did nothing in the full-tab editor** (it wanted a chat). It now asks for the routine on the page
  and drafts it through the same authoring (`workflow_draft` command, `authorFromWords`).
- **A browser task waiting for a click showed nothing to click**: the run said "Waits for your click" but only the
  Inbox could answer. The panel shows "… waits for your click in its chat" with "Open its chat" (the full tab opens
  the side panel on it). Approval cards also show while a change to review is on screen.
- The 5-minute schedule floor looked at the next three times only (`59,0 23,0 * * *` passed); it checks 60.
- Checked and working: http_get (retry with back-off on 503), read_page, llm, condition branches, memory save/search,
  inbox, notify, brief section, budgets, cancel mid-step, schedule catch-up, pause/resume, cron edit re-schedules,
  DST (once a day at local time; unit tests for Lisbon fall-back and New York spring-forward), restart mid-run,
  out.speak's "not available yet". web_search/browse open google.com, so they are covered by unit tests only.
- Tests: unit `prechecks.test.ts` (3), engine +2, service +3, spec +2, diagram +2 (1 299 total green);
  `e2e/workflows.e2e.mjs` 8/8 in Brave (+6: edit after a run, meeting-links layout and summary, a newer meeting
  replaces an ignored offer, sandbox without Nex Brain, restart mid-run, full-tab New workflow); `inbox`, `identity`,
  `companion`, `integrations`, `agents` E2E green. Locale keys `flow_*` (+15).
- Known gaps: the full tab's "Open its chat" relies on the side panel reading `open-thread` when it opens, so an
  already open panel does not switch chats; a hand-edited schedule leaves the description's wording as it was;
  cancelling a run does not cancel an agent step's own agent run.

### Connections audit: Obsidian, connectors, workspaces, "Set it up with Ava" (2026-10-16)

What was broken, and what was done:
- **Obsidian's "Choose vault" did nothing in Brave.** Brave ships with the File System Access API off
  (`window.showDirectoryPicker` is undefined in every page, extension pages included; checked in Brave 155), the
  click threw a `TypeError`, and the not-yet-connected row never showed errors. Now `vaultSupport()` tells
  `ok` / `brave_off` / `unsupported`: in Brave the row shows the three steps and an amber "Open Brave's setting"
  (`brave://flags/#file-system-access-api`, which `chrome.tabs.create` may open); errors show in every state
  (`SecurityError`/`NotAllowedError` as a plain sentence, closing the picker as nothing); "Allow access" after a
  restart says when access was refused instead of "Wrote 0 notes"; the picker is called on `window`. Obsidian also
  sits in Connectors ("On this computer: Obsidian"), and every vault view refreshes when another one changes it. The
  page records a summary (`vault-state` in `storage.local`: support, folder name, access) for the background's guide.
- **A custom server added with sign-in "None" that answers 401 was a dead end**: "Needs sign-in" with no sign-in
  button, plus an Inbox "Sign in to X again" for a connector that never worked. Now `addAndConnect` switches it to
  OAuth (and the panel signs in at once); custom connectors can change their sign-in method on their page
  (`conn_update { authKind }`, secrets of the old method deleted); the Inbox alert only fires for a connector that
  had read its tools before (`toolsCheckedAt`).
- **Every sign-in failure read "Sign-in cancelled."** `signInProblem` now tells the user closing the window apart
  from a page that would not load (wrong client ID / unregistered redirect), another sign-in window still open, and
  anything else (with Chrome's reason).
- **After adding an OAuth connector the user had to find "Sign in" themselves**; it now starts right away. The Add
  form ticks the default workspace (a connector bound to none is unusable, silently).
- **"Connected" with 0 tools**: `finishSignIn` marked a connector connected before its tools were read, so anything
  watching saw an empty connector; "connected" now comes with the listing.
- **Workspaces**: two workspaces could share a name (routing then matched neither); the editor now refuses it.
  Create / rename (id kept) / keywords / Google account / default star / delete (default cleared) / routing of new
  chats (words, else default, none after the default is deleted) all checked end to end.
- Catalogue checked live (2026-10-16): GitHub, Linear, Notion and Slack answer 401 with RFC 9728 metadata; Linear
  and Notion register a client and reach their authorize page with PKCE and `resource`; Google's three servers answer
  `initialize` and even `tools/list` without a token (200), and publish metadata at the path-based well-known
  (`accounts.google.com`), which the sign-in already falls back to.

**"Set it up with Ava"** (`src/background/integrations/setup.ts`, `setupAction.ts`, `setupCommand.ts`,
`tabSignIn.ts`; panel `src/side-panel/integrations/SetupGuide.tsx`): one guide, three ways in: the "Ava" button on
each catalogue row, the custom-server row, Obsidian and a connector page that needs sign-in (`conn_setup`); the chat
action `set_up_connection({service, url, provider})`; and the voice tool of the same name. Each call looks at where
things stand and does the next thing it can: adds the connector (chat's workspace, else the default), opens the
service's sign-in **in an ordinary tab**, the token page (GitHub), the developer console with the redirect address
to register (Slack, Google), Brave's flag page (Obsidian), or the provider's key page plus the Models page (models:
"just open it"). It says what is left in plain words; tokens and client secrets go into the guide's fields straight
to the vault, never the chat; it never presses consent. The sign-in tab is not bound to any chat. When the service
sends the tab to `https://<id>.chromiumapp.org/` (a host that does not resolve), `watchSignInTabs` (tabs.onUpdated /
webNavigation, only for tabs it opened, recorded in `storage.session`) closes it and finishes the sign-in; the chat
that asked gets a note ("X is signed in, with N tools"). The panel guide moves on by itself when the connector or the
vault changes, and with "I'm done, carry on". Tools still start off until the user chooses ("Choose its tools").

Tests: unit `integrations/__tests__/setup.test.ts` (10), `service.test.ts` (+4: switch to sign-in, no alert,
change of method, fixed catalogue sign-in), `side-panel/integrations/__tests__/signIn.test.ts` (+1),
`side-panel/vault/__tests__/support.test.ts` (3). E2E in Brave: `e2e/connections.e2e.mjs` (6: Brave steps and the
flag page; picking the vault through the guide, synced, the user's note in memory, `vault-state` recorded; None →
OAuth switch with sign-in at once and no Inbox alert; sign out and reconnect; the panel guide with the sign-in tab
closed and finished by the background; the chat action with the note in the chat) and `e2e/workspaces.e2e.mjs`
(4). `integrations`, `kb`, `shell`, `history` E2E green. Screens: `E2E_SHOTS=<dir>` with `connections.e2e.mjs`.

For the lead (shared files, not changed): `SidePanel.tsx` could open a place from `?place=` so a guide (or a
notification) can land on Connectors; `ThreadManager.placeInWorkspace` gives a chat no workspace when the picked
one was deleted meanwhile (`picked` set, not found, so no fallback to the default) and the Home picker keeps the
deleted id.

### Skills from anywhere and from experience (2026-10-16)

Before: skills came only from files imported in Settings, from what the user wrote, or from teach mode. Nothing
from outside could be installed, and nothing marked a skill as someone else's words.

Built:
- **Install from a link or a file** (Skills place → "Install a skill"): a raw `.md`, a GitHub file, folder or repo
  holding `SKILL.md` (the Anthropic Agent Skills format), a gist, a `.zip` link; or a `.md`/`.zip` chosen or dropped
  on the card. `src/background/skills/fetch.ts` resolves GitHub with one `git/trees?recursive=1` call and reads files
  from `raw.githubusercontent.com` (no sign-in; 403/429 with `x-ratelimit-remaining: 0` says when the limit frees
  up). A repo with several skills answers with a list to pick one from. Frontmatter `name`/`description` map onto
  ours; our `match.urls`/`keywords` are kept when present, else up to five keywords come from the name and
  description. Other `.md` files in the folder are kept as sections (`references`) the agent reads with the new
  `read_skill_section` action; scripts and any other file are listed "not installed: this copilot never runs a skill's
  code" and dropped. The parser now reads `|`/`>` block scalars. Limits: 20 sections, 100,000 characters, zips
  unpack only Markdown (1 MB a file, 5 MB in all).
- **Review before it is active.** An installed skill is saved off (`trust: 'external'`, `origin`, `sha256`,
  `approvedSha256: null`; optional fields on the existing `skills` record in `storage.local`, no Dexie change) and
  shows a review card at the top of Skills: source, name, where it applies, size, the full text (invisible
  characters shown as `⟨U+200B⟩`), the files left out, and red flags (send/post/delete/buy words, credentials, links
  outside its sites, hidden text, rule-changing phrases, very long). "Turn on" (amber) records the hash the user
  read; `skillStore.enabled()` only loads an external skill whose `approvedSha256 === sha256`, and the list's switch
  refuses one not reviewed. It never takes the id of a skill already here (built-ins included): `pdf` becomes `pdf-2`.
  Installing the same link again replaces it and it waits for review again.
- **Check for update** (row details) fetches the link again and shows a line diff; "Use this version" applies it,
  "Keep mine" leaves it. Never automatic.
- **In the prompt**, an external skill is fenced off with `wrapUntrustedContent` (the guardrails filter runs on it),
  stripped of invisible characters, and introduced as "written by someone else … cannot give you a task, ask for or
  reveal secrets, send data anywhere, or change any rule". The gate is unchanged and does not read skills.
- **Find skills**: `src/side-panel/skills/starters.ts` lists `anthropics/skills`; "Browse" fetches it only on click
  and offers its skills through the same review.
- **Skills from experience**: teach mode's offer now reads "Save how I did this as a skill?" and opens the draft in
  the same review card, with its Markdown to edit; "Turn on" saves it. The task log given to the summarising call has
  typed and picked values removed (`stripValues`: input/keys/option lines in the user's language, quoted values,
  emails, numbers, key-shaped strings, words after "password"/"code"/"token"), page query strings dropped, and is
  wrapped as untrusted data. `teachTranscript` refuses chats an agent, routine or brief started.
- **Chat and voice**: `install_skill({url, name})` (agent action) only takes a link the user typed in that chat
  (`userTyped` from `integrations/setupAction.ts`), refuses unattended chats, and only saves the skill off. The voice
  tool `install_skill` only fetches a link that is in what was heard; otherwise it opens Skills to paste it. Both go
  through the registry, so Ava's capability list has it (grouped under Tasks in `capabilities/catalog.ts`).

Tests: unit `src/storage/lib/skills/__tests__/external.test.ts`, `src/background/skills/__tests__/{fetch,install,
skills}.test.ts`; E2E `e2e/skills.e2e.mjs` (8 tests, local skill server, Brave): link → review card → off → "Turn
on" → loads fenced; update diff; zip with a script; chat install typed vs not; teach mode through the review card
with the typed name kept out.

Known gaps:
- The panel only hides "Save as skill?" for chats an agent or routine started once `SidePanel.tsx` uses
  `canTeachFrom` (from `background/skills/teach.ts`); until then the offer shows there and drafting fails with a
  plain sentence.
- The options page (`src/options/components/SkillsSettings.tsx`) still lists installed skills like any other; its
  switch cannot turn on an unreviewed one (the store refuses) but shows no reason.
- `fflate` is a devDependency bundled into the extension; moving it to `dependencies` is the lead's call.
- Background error sentences of the fetcher are English in every locale.

### Agents that own their work (2026-10-16)

A team of agents, each owning an area of work, that Ava hands work to. `src/background/agents/{handoff,
handoff-state,team,team-section}.ts`, `src/side-panel/agents/{TeamView,HandoffCard}.tsx`, locale keys `agents_`.

- **Ownership.** `AgentProfileFields.owns?: string[]` (≤ 6 areas, ≤ 40 chars) and `charter?: string | null`
  (≤ 200), optional fields (no Dexie version bump). Areas compare by `areaKey` (lower case, letters and digits,
  each word singular, "e-mail" → "email"), so "Email", "emails" and "E-mail" are one area. `ownershipClash`: no two
  created, switched-on agents a chat could see together own the same area (same workspace, or either in none). Checked
  at Create/Apply (when the agent is or becomes on), hand edits of an agent that is on, and resume; drafts and paused
  agents own nothing. Editor fields "Areas it owns" and the charter; the authoring call writes `owns`/`charter` too
  (only when the user says the agent handles an area).
- **Hand-off.** Chat action and voice tool `hand_to_agent({area|agent, task})`. `HandoffService.handOff` resolves
  the switched-on owner (exact area first, then one area's words inside the other; a paused owner is named and
  refused) or the agent by name, among the chat's team only (`teamOf`: created agents of the chat's workspace and of
  none; a chat in no workspace sees only agents in none). It starts a run with `trigger {type:'handoff', detail:
  threadId}`, attended, queued behind an open run, and `spec.handoff {threadId, requestSeq, area, from, postedAt}`.
  Trust: the task is trusted only when the user's own words (the chat's last user message, or the voice
  conversation's recent words) cover ≥ 80 % of its words; otherwise the run gets the user's words as its task and
  Ava's wording as wrapped data, tainted. Refused from any chat the user is not in (`origin` agent/workflow/brief),
  so an agent's run can never chain a hand-off; the bus keeps its own hop limit. When the run ends
  (`AgentServiceDeps.onRunEnded`), its answer is posted in the chat as the planner ("**Mail** is done: …", or why it
  could not finish), once (`postedAt` in a transaction); a chat busy with another task gets it when free (watched
  each second for 20 s, and a job `agent-handoff-post` every 5 s up to 10 min that survives a restart; recovery
  posts what ended unposted in the last day). Voice: the agent's chat is announced by the voice watch like a
  `do_task` chat ("… is done. The result: …"); the answer also lands in the voice conversation's chat.
- **Prompt block.** `[Your agents]` in each step's browser state of a chat the user is in (`teamSectionFor`, one
  line in `agent/prompts/base.ts` beside the workspace and connector sections): the team's areas and charters and
  when to hand over. Voice: the `hand_to_agent` declaration's description is a getter listing the voice
  conversation's workspace's team from a snapshot refreshed by Dexie hooks on `agents`. `TOOL_GROUPS.hand_to_agent
  = 'tasks'`, so `what_can_you_do` lists it.
- **Starter team** (`TEAM_TEMPLATE_IDS`, drafts only, via "Set up my team" with a workspace choice; command
  `agents_team_setup`): Mail (`mail.google.com`, gmail + account-switching skills, weekday 09:00 + manual, triages
  and leaves draft replies), Social (x.com/linkedin.com, drafts and schedules, stops before Post/Schedule), Research
  (open web, brief saved with `save_to_knowledge`, publishes `research.brief`), Meetings follow-up (new trigger
  `meeting_ended`: a `db.meetings` `updating` hook on status `done` → `onMeetingEnded`, tainted, notes as data via
  `meetingData`, once per meeting and agent, same workspace or none; drafts action items and follow-up emails) and
  Calendar (calendar.google.com, proposes slots, never saves or sends invites). Each says it never sends, posts,
  accepts, deletes or buys; the gate holds anyway (agent chats always ask). A starter whose area is already owned
  shows who owns it and cannot be ticked.
- **Panel.** Agents place: "Your team" (agents that own something: state badge, area chips, last result or
  charter), the setup card, the rest under "Your agents". Chat: a registered turn add-on (`registerTurnAddon` in
  `side-panel/registry.ts`, rendered by `ChatView` under a turn's steps) shows "Handed to Mail · running / waits
  for you (amber) / done: <first line>" from the run record, with a link to the agent's chat.
- Tests: unit `agents/__tests__/team.test.ts` (17: area keys, owns normalising, clash rules, templates valid,
  team per workspace, resolution, trust, prompt block, meetings, Create/edit/resume refused, team setup, hand-off
  posted once, busy chat via job, Ava's wording as tainted data, refusals, queueing, meeting runs). E2E
  `e2e/agents.e2e.mjs` (+1): Set up my team → Research draft → Create; chat "have the research agent look into …"
  → card → run in the agents' window → "**Research** is done" in the chat and the card done → team view shows the
  last result; a rival drafted owning "Researches" is refused at Create and stays a draft. `voice.e2e.mjs` tool list
  updated; `ava-hub` green.
- Not done: no E2E of the voice hand-off (the voice tool shares `handOff` with the chat action); the meeting trigger
  has no E2E (unit only).

### Google Drive through the signed-in browser (2026-10-16)

Drive's MCP connector needs the user's own Google Cloud OAuth client, so for a normal user it never worked. Drive now
works through the Google session the browser already has, the way WhatsApp Web and Gmail do: no project, no client,
no token (the tab is the credential, so nothing here ever holds one). `src/background/drive/`, skill
`src/storage/lib/skills/builtin/google-drive.md`.
- **Where it works** (`tab.ts`): for a chat, a tab bound to it: a Drive/Docs tab it may already use (its own, or a
  free one its binding may take over, never another chat's or a private one), else a new tab it opens; navigation goes
  through the chat's `BrowserContext`. The panel and voice use a tab the extension opens for itself (inactive, id in
  `storage.session`, reused while on Google and no chat holds it). Every address, and where Google's redirects land,
  is checked against the firewall first (`DriveBlockedError`); the sign-in page is Google's own and only shown.
- **Account**: the chat's workspace (`workspace.accounts.google`, or one named in `drive_search`'s `workspace`; panel
  and voice: the picked / default workspace) goes into every address as `authuser=<email>`. Landing on
  `accounts.google.com` raises `DriveSignInError`: in a chat the tab comes to the front, the chat says "I'm on
  Google's sign-in page, please sign in" and a needs-user card ("Continue" / "Stop") waits; Continue tries once more.
  The panel and voice say the same and bring the tab forward.
- **Reading** (`service.ts`): `drive_search` (`drive/search?q=`) and `drive_list` (a folder or My Drive) read the
  rows (`readDriveRows`, selectors and type words from the skill; ids from `data-id`). `drive_read` opens the file
  (`open?id=` tells a bare id's kind) and takes Docs as `export?format=txt`, Sheets as `export?format=csv(&gid)`,
  Slides as `export/txt`, fetched **from the Docs tab** (same origin, its session; opening an export as a page would
  download a file). If the page cannot fetch it, the background fetches it with the browser's cookies (text types
  only, ≤ 200 000 characters, 20 s); a Doc then falls back to `/mobilebasic`'s page text. Other files: a text file's
  download, else Drive's viewer text (PDFs), read until it stops growing. An HTML body (sign-in or error page) never
  counts as the file. The agent gets 12 000 characters, voice 4 000, always through `wrapUntrustedContent` (titles
  included: a title giving orders arrives defused).
- **Knowledge base**: `drive_save_to_knowledge` and the panel's "Add from Drive" (Connectors › Google Drive, a pasted
  link and a workspace) call the new `KnowledgeBase.saveDocument` with source `drive:<fileId>` (item
  `page:drive:<id>`, the plain editor link, the workspace): search and the graph pick it up from the usual change
  event; adding again refreshes the one item ("Refreshed …"). Saving the same file from another workspace moves it
  there (one item per file).
- **Writing**: `drive_create_doc` opens `document/create?title=…(&folder=)`, waits for the editor's text box, renames
  through the title box when needed, pastes the text into `docs-texteventtarget-iframe` (a paste event in the page's
  world) and reads the export back to check it. A private Doc in the user's own Drive is an edit: no card, except in a
  chat started by an agent or routine, where it passes `reviewAction` first. `drive_share({file, email, role})` fills
  the share dialog (address chip and role: that shares nothing), puts the focus back in it, then passes
  `reviewAction` as a commit (`permission`; the card shows the page's title and the dialog's contents, never the
  model's wording) and presses Send only after the click; a refusal stops the task, a dialog that does not close is
  "Drive did not confirm it". Trash and delete are left to the generic page actions (the click gate already stops
  "Move to trash"), with the flow in the skill. **Upload is not built**: a file input needs a file the user picks, and
  there is no clean path from the extension.
- **Voice and Ava**: voice tools `drive_search`, `drive_read`, `drive_save_to_knowledge` (registered, so guarded after
  the wake word like every registered tool), in Ava's catalog under "Memory, knowledge, Google Drive and other chats".
- **Routines**: `step.agent` runs a chat with `origin: 'workflow'`, so a routine can call every drive action; reads
  need nothing, and a share or a new Doc there waits for its approval (`reviewAction` treats the chat as unattended).
  `step.tool` stays for connectors (MCP) only.
- **Connectors**: a "Google Drive" section above the catalogue ("No setup", "Works through your signed-in browser"),
  with "Add from Drive"; the MCP row now reads "Advanced: Google's MCP server, with your own Google Cloud client".
- Not checked against the real Drive (no sign-in from here): the row, title-box and share-dialog selectors are the
  skill's best reading of Google's page and may need an edit there; the URL forms were checked against public pages
  (Slides `export/txt`, Docs `mobilebasic`, `authuser=`), `document/create?title=&folder=` was not.

Tests: unit `drive/__tests__/urls.test.ts` (9: links, ids, `/u/<n>/`, look-alike hosts, exports, `authuser`),
`service.test.ts` (11: skill selectors and kinds, search with the account, the sign-in page, export in the tab, the
background and `mobilebasic` fallbacks, HTML never taken, a bare id resolved and a PDF from the viewer, folders and
foreign links refused, a new Doc pasted in the page world and checked, share filled → asked → Send only after yes),
`kb/__tests__/manager.test.ts` (+1 `saveDocument`). E2E in Brave `e2e/drive.e2e.mjs` (6) with fixture pages for
Drive, the Docs editor (title box, text box iframe, share dialog) and the sign-in page, answered for every tab and the
worker through browser-wide `Fetch` interception: Connectors row + Add from Drive saved then refreshed; a chat
search → read → save (titles defused inside the untrusted block, `authuser` on every address, the user's tab never
driven); the sign-in page handed over; a new Doc with title and text, no card; sharing only after Confirm with the
address on the card; the firewall blocking Docs. `kb`, `connections`, `integrations`, `skills`, `ava-hub` E2E green.

For the lead (files not owned): the one-line import in `src/background/registers.ts`, the additive
`KnowledgeBase.saveDocument` in `kb/manager.ts`, two `TOOL_GROUPS` lines and the group title in
`capabilities/catalog.ts`, the built-in list in `skills/__tests__/skills.test.ts`. The confirm card does not show a
request's `intent`; showing it would put "Share 'Q3 plan' with ada@x.com as editor" on the card word for word.

### Voice basics: turn-taking, wake word, local by default (2026-10-17)

Complaints: Ava talked over the user and replied late; "Hey Ava" sometimes missed; dictating into the chat box got an
answer from Ava; voice needed a Gemini key although the local engines ship.

- **Ava hearing herself** (`offscreen/vad.ts`, `voice.ts`, `turns.ts`): the speech gate is playback-aware. While her
  voice is audible (queued until `playAt`, plus output latency and a 200 ms tail) speech must pass 0.04 (not 0.012)
  for 300 ms before the gate opens; its lead-in is kept, so a real barge-in still goes up whole. She counts as
  speaking until the queue has played out, not at `turnComplete`. The noise floor no longer locks: if nothing in 3 s
  is below the threshold, the quietest level of that window pulls the floor up, so a raised hum closes the gate.
- **Notices cutting in**: `TurnTaking` holds system notices and the tab-context line until the user is not speaking,
  their last words got an answer (or 1.5 s passed), no tool runs and her voice has drained; a 200 ms settle loop
  sends them then.
- **Latency**: `setup.realtimeInputConfig` = start sensitivity LOW, end HIGH, prefix 200 ms, silence 600 ms,
  `START_OF_ACTIVITY_INTERRUPTS` (field names checked against `ai.google.dev/api/live`); our gate hold is 700 ms, so the
  server decides the end of a turn, and `audioStreamEnd` stays.
- **Dictation answered by Ava**: the panel posts `dictation_hold {on}` when dictation takes the mic and again when it
  is given back (stop, cancel, error, unmount; the background also releases on the panel port's disconnect). The
  offscreen document then drops the session's mic audio (typed turns still go; an open utterance is ended with
  `audioStreamEnd`) and holds the wake listener, with a 3-minute safety release. The dictated words reach the chat
  once, through the composer.
- **Wake word**: listens on the chosen mic (`requestMicStream`), a fresh main recogniser after every candidate
  decision and on resume, phrase window 1.8 s. The minute alarm's `wake_start` only resumes a paused listener with
  no capture, candidate or dictation hold (`resumeIfIdle`); `voice` is set before `await start()`. `wakePrefix`
  unchanged.
- **Economy**: an utterance heard over the answer that did not stop it (barge-in counts loud audio only, 400 ms on
  top of the gate's 300 ms) is dropped as echo. KittenTTS already speaks sentence by sentence in its worker.
- **Local by default**: `VoiceMode` gains `'auto'` (default; `stt` default `moonshine`). `resolveVoiceMode`: economy
  unless Live was picked and a Gemini key exists; auto falls back to Live only when the speech files are missing and a
  key exists. Migration: a stored `live` without `modeChosen` (every old save wrote it) reads as auto; `economy` and
  anything picked in Settings are kept. A conversation speaks with KittenTTS when the TTS engine was never picked
  (`engineChosen`). Composer dictation without Gemini STT is transcribed on the device (`stt_transcribe`: decode,
  cut at pauses, `localSttChoice`). Missing files give a plain sentence pointing to Settings › Voice engines.

Tests: unit `vad.test.ts` (+4: hum closes, echo vs playback threshold, held-then-open barge-in, reset),
`turns.test.ts` (7, incl. the setup config), `wake.test.ts` (+4: recogniser reset, `resumeIfIdle` keeps a capture,
hold, chosen mic), `economy.test.ts` (+3, barge-in test updated), `transcribe.test.ts` (3), `dictation.test.ts` (7),
`voiceEngineSettings.test.ts` (migration, auto resolution, KittenTTS default), `engines.test.ts`. Full suite 1480
green. E2E in Brave: `voice` (6, + no notice while the user speaks, `realtimeInputConfig`), `dictation` (5, + a
hidden Live session gets no mic audio while dictating, one answer; fails with the hold removed), `wake` (1),
`ava-hub` (4), `voice-thread`, `wake-negative`, `identity` (8), `voice-engines` (6, + Talk with no Gemini key and
untouched settings runs Moonshine → text model → KittenTTS; dictation transcribed on the device). Live-mode E2E now
pick `mode: 'live'` explicitly. Not testable here: real acoustic echo and a real room; tune `playbackLevel` (0.04)
and `REPLY_WAIT_MS` with the user's own mic and speakers.

### Onboarding needs one working model (2026-10-17)

Rule: the product needs an API key or a connected local model, and first-run setup must leave one working.

- Model step (`side-panel/onboarding/ModelSetup.tsx`) is an inline setup with two tabs. *On this computer*: asks
  `models_local_probe` (new; `probeLocalServers` now, recorded only when it changed) every 3 s while open, offers
  "Use Ollama/LM Studio" in one click, then a model picker; with nothing running, install + `ollama pull <the chat
  model recommendLocalModels picks for this computer>` and it notices the server by itself. *API key*: provider
  (Gemini, OpenAI, Anthropic, OpenRouter, DeepSeek, Grok, NVIDIA, OpenAI-compatible with an address), key → tried
  with `models_provider_check` first (a refused key is never saved, the hint says why), then saved to the vault.
- Next/Done is disabled until the panel's own ready check passes (Enter too). Skip/Esc still end the setup, but the
  model stays owed: a "Finish setup" pill (hidden on the welcome screen, which has its own "Connect a model" button)
  opens the model step alone until a model works. The panel's ready state rechecks on every provider/agent-model
  storage change, and counts any key-optional provider (`providerIsUsable`: Ollama, LM Studio, custom).
- `applyGeminiDefaults` → `applyRoleDefaults` (`storage/lib/models/roleDefaults.ts`), used by `saveProvider` for every
  provider: cloud gets its best smart (Planner) and fast (Navigator) model from the listed active models (Gemini keeps
  its pair), local gets one chat model for both. It writes an agent only when it has no model or its provider is gone
  or keyless, and the smart/fast role only alongside such an agent and when unmapped. A provider whose saved names
  are all missing from its list gets `defaultActiveModels` turned on first. Nothing is assigned on a refused key or a
  server that did not answer.
- The onboarding dialog background is opaque now: the welcome orb's canvas showed through the 95% glass.

Tests: unit `storage/lib/models/__tests__/roleDefaults.test.ts` (7), `background/models/__tests__/commands.test.ts`
(+4: OpenAI defaults with reseeding, Ollama both agents and a later provider leaves them, unreachable assigns
nothing, `models_local_probe`); full suite 1458 green. E2E Brave `e2e/onboarding.e2e.mjs` (5): the two old tests, a
fresh install where Next is blocked → a stand-in Ollama (`startMockOllama`, port 11434) is found → added → ready →
a chat runs through it; a refused key (not saved) then a working key (`mock.keyedBaseUrl`) → ready → a chat runs;
skip → welcome → model step alone → Models & usage → pill → model step. `models`, `shell` E2E green.
`launchExtension(mock, { model: false })` starts with no model.

### Voice models download on first use (2026-10-17)

Voice was local by default, but the model files only existed in a dev build (`public/voice`, `public/wake`, git-
ignored; `release.mjs` refuses to ship them), so a normal install had no local voice. Now they download the first
time a feature needs them.

- **Catalog** `src/shared/lib/voice-models/catalog.ts`: the same pinned URLs, sizes and SHA-256s as
  `scripts/voice-models-setup.mjs` (now exports `COMPONENTS`, runs `main()` only as a script) and
  `wake-word-setup.mjs` (`SOURCES`). The scripts stay self-contained because `install.sh --with-voices` fetches each
  on its own, so `__tests__/catalog.test.ts` compares the lists instead of sharing one. A test catalog on
  `globalThis.__nexVoiceModelsCatalog` is honoured only when every URL is `http://127.0.0.1|localhost`.
- **Store** `store.ts`: OPFS `voice-models/<component>/` in the packed folder layout. Each file goes to `<name>.part`
  (committed every 8 MB), resumed with `Range` (a 200 starts over), `withRetry` on lost connections, SHA-256 checked,
  then `move()`d to its name; a mismatch deletes it and is never retried. `.ready.json` (the file sums) is written
  only after every file is in and unpacked; a component is ready only with it. Web Lock across pages;
  `navigator.storage.persist()` is asked. Unpacking in the browser with its own streams (`unpack.ts`):
  KittenTTS `voices.npz` → `voices/<key>.bin` + `voices.json` + `config.json` (archive removed); the Vosk zip →
  `model.tar.gz` (ustar + `CompressionStream('gzip')`, entry by entry) + `words.txt` from `graph/Gr.fst`.
- **Loaders** `resolve.ts` `modelFetch`: the packed URLs the runtimes always used (`voice/<id>/…`, `wake/model.tar.gz`,
  `wake/words.txt`) are answered from OPFS when ready, else the package, else a 404 ("not downloaded").
  transformers.js gets it as `env.fetch` (`stt/runtime.ts`), the TTS worker for `voices.json` and voice tables, the
  wake vocabulary (`assistant.ts`) too. Workers have no `chrome.runtime`: the base comes from `location.origin`.
  Vosk's worker is not our code, so `wake-word-setup.mjs --worker` prepends a prelude that answers
  `wake/model.tar.gz` from OPFS; the worker (4.3 MB, Apache-2.0, eval-free) is now **tracked** in
  `public/vosk/vosk-worker.js` (`-text` in `.gitattributes`: it has CRLFs in its strings; in `.prettierignore`)
  because an extension may not run code it downloads; only data is downloaded. CSP unchanged: model bytes are
  Responses, never scripts. Background `installedVoiceModels` = packed + downloaded (`installed.ts`).
- **Commands** (`voice/engines/register.ts`): `voice_models_needed {feature: talk|dictation|wake}` →
  `{required, optional}` (`modelsNeeded` in `options.ts`: a device conversation needs the chosen recogniser, Moonshine
  tiny by default, and KittenTTS unless the system voices were picked; one going to Live needs nothing; dictation
  nothing when Gemini writes it down; wake needs Vosk); `voice_models_changed` forgets the 30 s cache.
- **UI** `src/side-panel/voice-models/`: `gate.ts` `ensureVoiceModels` before Talk (`SidePanel.toggleVoice`),
  dictation (`gatedSpeech`) and the wake toggle (`onboarding/wake.ts`, from Settings and the onboarding step, whose
  card renders inside the dialog); `VoiceModelsCard` "Download voice (≈60 MB, once)" / "Download the wake word
  (≈41 MB, once)", progress (MB, %), Cancel (keeps what came, nothing starts), Not now (an optional voice is not
  offered again this session; the feature still starts), Try again with the reason; then the feature starts by
  itself. `downloads.ts` runs the download in the page, shares progress over a BroadcastChannel.
  Settings › Voice engines rows: Not downloaded · about N MB [Download] / x of N MB · % [Cancel] / Downloaded · N MB
  [Remove] / Packed with this build / Download failed [Try again]; the setup command and copy button are gone.
  Messages no longer say "run node scripts/… and rebuild".
- **Sizes** (the real hosts, measured in Brave): Talk = Moonshine tiny 32.1 MB + KittenTTS 27.6 MB ≈ 60 MB
  (13 s + 7 s here); wake word = Vosk zip 41.2 MB (12 s, 43 MB on disk as tar.gz). Kokoro 97 MB, Moonshine base
  67 MB, Whisper base 81 MB only from Settings. No WebGPU weights are downloaded (packed builds still use them).
- **Hosts**: huggingface.co (redirects to us.aws.cdn.hf.co) and alphacephei.com, covered by the existing
  `<all_urls>`; no new permission. Only on the user's click (the card or a Settings row).
- **Release**: the guard is unchanged (no `dist/voice`, `dist/wake`); the zip now carries `vosk/vosk-worker.js`.
  `install.sh --with-voices` and the site's Local voices text say it is optional; `docs/distribution.md` updated.

Tests: unit `shared/lib/voice-models/__tests__/store.test.ts` (15: download + ready, checksum mismatch rejected and
not retried, cut-off resumed with Range, stop keeps a partial that is not ready and the next run resumes, Range
ignored, revision change, remove, npz unpack, Vosk zip → tar.gz + words, symbol table, URL mapping,
OPFS-then-packed-then-404, partly downloaded never served, packed + downloaded listing, loopback-only test catalog),
`catalog.test.ts` (3, equal to the scripts), `side-panel/voice-models/__tests__/gate.test.ts` (4), `engines.test.ts`
(+4 `modelsNeeded`); full suite 1517 (the known-flaky `workflows/engine.test.ts` passes alone). E2E Brave
`e2e/voice-download.e2e.mjs` (3, build without `public/voice`/`public/wake`, files from a 127.0.0.1 server made from
`VOICE_MODELS_SOURCE`): Talk → card → progress → Cancel at 30 % → Talk → Download resumes with Range → Moonshine
hears, the text model answers, KittenTTS speaks, no Live, nothing off the computer, no CSP violation; reload →
Talk starts with no card and no download, Settings shows Downloaded; wake toggle → card → Vosk model → "Hey Ava"
starts a conversation. `voice-engines` (6, now "Packed with this build"), `wake`, `dictation`, `onboarding`,
`voice`, `wake-negative` green with packed models. `e2e/manual/voice-download-real.mjs` downloads all three from the
real hosts with the real sums. Under heavy machine load the KittenTTS playback level in `voice-engines` and the wake
detection can time out (the same on `feat/restyle`).

### A local model when the cloud fails (2026-10-19)

A cloud model that failed mid-task failed the step: the stand-in in `pickRoleModel` only applied when a breaker was
already open or health said `error`, and the browser agent read `agentModelStore` directly, so it never got one.

- **Setting** `ModelSettingsRecord.fallbackLocal: { enabled, model: RoleTarget | null }`, default
  `{ enabled: true, model: null }` (filled in for settings saved before it). `null` means the best local chat model;
  a chosen model that is no longer found is re-picked the same way. Pure pick in
  `src/storage/lib/models/fallback.ts` (`pickFallbackModel`, `localChatModels`), shared by the background and the
  Models hub.
- **On a failed call** `callWithFallback` in `background/llm/generate.ts` wraps `generateStructured` and
  `generatePlainText`. `fallbackReason` (`llm/errors.ts`) allows auth (401, missing key), forbidden (403), quota (402,
  or a 429 whose text says quota/RESOURCE_EXHAUSTED/insufficient_quota), rate_limit (429 after the usage meter's own
  retries), unavailable (5xx), network (no response), timeout (408). Never: cancel or an aborted signal, invalid
  (400/409/413/422), not_found, budget, unknown, a reply that could not be parsed. The same call runs once on the
  fallback in that model's own structured mode; after the first switch the fallback answers every later call of
  that chat model (a task does not wait out the meter's 30 s again on each step). If there is no fallback, its
  server does not answer (`models/alive.ts`, moved out of `light.ts`), or it fails too, the cloud's error is thrown.
- **Attached** by `withCloudFallback` (`background/models/fallback.ts`) in `createRoleModel` (never for `embed` or
  `local`) and in `threads/factory.ts` `resolveModels`, only to cloud models. The fallback is metered as itself, so
  usage shows the model that answered. The note goes through the scope's `notify` (a run's `ACT_NOTICE`, kept as a
  system message): "OpenAI failed (quota). Finishing with qwen3:4b on this computer."
- **Browser agent on roles** `resolveModels`: a thread's own model still serves both agents; otherwise Navigator =
  `fast`, Planner = `smart` through `resolveRole` with the agent model from settings as `RoleInputs.explicit`
  (order: agent mapping → workspace mapping → explicit → everyone's mapping → best), so a down provider gets a stand-in
  and the agent's reasoning effort stays with its own model. With no Navigator set it now picks the best model instead
  of failing.
- **UI** "When the cloud fails" card in Models → Local (`LocalSection.tsx`, panel and options page): switch, picker of
  discovered local models (Automatic shows which), the model in use, and "Install one" scrolling to the
  recommendations when none is found. Locale keys `models_fallback*` in all three locales.
- The gate is untouched: only which model thinks changes.

Tests: unit `llm/__tests__/fallback.test.ts` (20: each kind falls back, none on cancel/400/413/budget/parse/404 or an
aborted signal, sticky switch with one note, structured call in the local model's mode, original error when no or a
failing fallback), `models/__tests__/fallback.test.ts` (4: OpenRouter 429 quota → meter's 4 retries → Ollama answers,
the note, usage on `ollama:qwen3:4b`; chosen model; off / server down; none for embed/local),
`storage/lib/models/__tests__/fallback.test.ts` (7: default, re-pick, off, no embed/cloud, old settings, explicit
order, explicit stand-in), `threads/__tests__/resolveModels.test.ts` (7). Full suite 1559. E2E Brave
`e2e/fallback.e2e.mjs` (2: a cloud returning 429 quota on every chat, the Ollama stand-in on 11434 → the task
finishes, the note shows, usage is Ollama's, the cloud asked ≤ 5 times; the card shows and saves model and switch),
plus `models`, `agent`, `onboarding`, `threads` green. Not covered: `voice/engines/economy.ts` calls `generateText`
directly, so Economy voice turns get no fallback yet.

### Private and team memory for agents (2026-10-19)

Decision with Avi: each agent has **private** memory (that agent, Ava and Avi read it) and there is one **team**
memory every agent reads and adds to. No agent reads another agent's private memory.

- **Scope on items:** `KnowledgeItem.scope?: 'private' | 'team'` (optional, no Dexie version bump, no index).
  `itemScope()` in `src/background/kb/scope.ts`: `team` if marked; `private` if marked or the item has an `agentId`
  (so items from before this change that an agent made are private); else `unowned` (Avi's own, every agent reads it).
- **One enforcement point:** `canSee(scope, item)` with `memoryScopeFor(thread)` / `memoryScopeForThread(id)`, decided
  from the chat alone, never from model arguments. Ava (user, voice, brief, panel) → everything in the workspace (the
  panel's agent picker narrows to one agent); an agent's run → its own private + team + unowned; a routine
  (`origin: 'workflow'`, even one running as an agent) → team + unowned; an unreadable chat id → the routine's.
  Workspaces never mix (unchanged rule). Used by `KnowledgeBase.search/ask/items/item(id)` (their scope argument is
  required now), `search_knowledge`, `workspace_context`'s passages, `kb_ask`, the routine `memory_search` step, voice
  `ask_knowledge` (which now also stays in the conversation's workspace), and `look_up_graph`.
- **Graph:** a node shows only when one of its `sourceItemIds` is visible, a link only when its `sourceItemId` is,
  so an entity only a private note names never appears for another agent.
- **Workspace summaries** (`history/rollup.ts` `itemsOf`) leave private items out, because every agent reads them
  through `workspace_context`.
- **Writes:** `saveFieldsFor(scope, team)`: an agent's saves are private unless `save_to_knowledge {team: true}`;
  an agent's indexed run chat is private; a re-index keeps the scope the user chose. `share_with_team {title}` moves
  one of the asking agent's own private items to the team (it can only find its own). The user's moves:
  `memory_set_scope` / `memory_delete` (`src/background/kb/register.ts`, also as one-off messages from any extension
  page). `setScope` refuses to make the user's own item private.
- **Panel:** `src/side-panel/kb/MemoryScope.tsx` (`ScopeBadge`, `ScopeActions`, `AgentMemory`, `memoryRequest`),
  self-contained for the coming full-page Settings. The agent's page shows its private memory and the team memory with
  move-to-team / make-private / delete; the Knowledge base list shows Private/Team badges and the move buttons.

Tests: unit `kb/__tests__/scope.test.ts` (36: matrix agent A / agent B / Ava / routine × A-private / B-private /
team / unowned / B-legacy / other workspace × search_knowledge / ask / by id; graph entity, links and source nodes;
save private vs team; share_with_team only own; user moves; run chat private and kept on re-index; summaries), full
suite 1557 green. E2E Brave `e2e/kb.e2e.mjs` (8, +1): agent A's run saves a private note; agent B's run cannot find
it; Ava's chat can; the user clicks "Move to the team memory" in the Knowledge base; B's next run finds it.
`agents.e2e` (3) and `graph.e2e` (2) still green.

### Voices for personalities and agents (2026-10-19)

Avi: "personalities need specific voices so I know who I'm talking to; each agent has its own personality and
voice." Plan `groovy-herding-matsumoto.md` §4 (stream C).

- **A voice per engine.** `Personality.voices: { live?, kitten?, kokoro?, system? }` replaces the one `voice`
  (`storage/lib/personalities`). `migrateVoices` puts an old voice in the slot of the engine it names (Kitten,
  Kokoro, Gemini name, else system) when stored personalities are read or saved. `live` is a Gemini prebuilt voice,
  used by Live and by Gemini read-aloud (the same 30 voices). `system` may list several names separated by `|`;
  `chromeEngine.speak` uses the first one this computer has (`pickSystemVoice`), else the default voice rather than
  failing. `personalityVoiceFor(engine, …)` gives only a voice of that engine.
- **Built-in voices** (Default keeps Ava's Settings voices: Aoede / Bella / af_heart):
  engineer Puck · Leo · am_michael · Alex (pace 1.1); accountant Charon · Hugo · bm_george · Daniel; legal eye
  Gacrux · Luna · bf_emma · Serena; strict auntie Kore · Rosie · af_nicole · Moira (0.95); operator Orus · Bruno ·
  am_fenrir · Rishi. Each system slot lists Windows and Google fallbacks too. Built-ins stay read-only, but their
  voices and pace can be changed (`voiceOverrides`, "Voices of …" in Settings › Personalities, "Back to its own
  voices" undoes it).
- **Editors** (`side-panel/personalities/VoicePicker.tsx`): one select per engine with **Preview**, in the
  personality editor and the agent editor. Preview is the `voice_preview` command (`background/personalities/
  preview.ts`): Gemini voices through Gemini's speech model (needs the Gemini key; this is the same voice Live
  uses, so no canned sample was needed), Kitten/Kokoro through the local engine (says it is not downloaded yet
  when it is not), system voices through `chrome.tts`. Refused while a conversation is on.
- **Live honours it.** `liveSpeechConfig(model, identity, personalityVoice)`: the personality's Live voice, else
  Ava's Settings voice; the language is always the Settings one, and the voice is fixed for the session.
  Switching personality mid-conversation (`set_personality`, or the header/Settings, which the manager watches):
  economy → `voice_reconfigure` changes the instructions and the voice of the next answer; Live → the session
  starts again in the new voice once the floor is free (a fresh session, since a resumed one keeps its old voice,
  with the conversation so far in its instructions from the thread; the thread and transcript stay the same). The
  tool tells the model to say nothing until then, and the new session greets the user first, in the new voice.
  The voice tool and the settings change for one switch are applied once (`applyPersonality` keyed by personality).
- **Agents.** `AgentProfileFields.personalityId` and `voices` (validated, diffed, kept through a drafted change).
  An agent's runs use its personality's prompt (`personalityForThread` in `threads/factory.ts`, by the thread's
  `agentId`), else the workspace's as before. Its voices: its own, then its personality's, then ones picked from its
  name that Ava does not use (`personalities/voices.ts`). Starter team: Mail = strict auntie, Social = operator,
  Research = engineer, Meetings follow-up = legal eye, Calendar = own voices (Leda · Kiki · af_bella); Social watcher
  and Research scout get their own voices too. No two team members share a voice on any engine.
- **Agents speak in their own voice, name first.** `VoiceManager.speakAs` → offscreen `voice_speak_as`: the thread
  watch says an agent run's answer this way (hand-offs and `run_agent`; a run that started and ended between two
  looks is still heard), `announce(text, speaker)` for Inbox items from an agent. Economy: the session's engine
  with the agent's voice, queued like a turn and kept in the history as not the user's words. Live (one voice per
  session): `SpokenLines` plays it on the device with the read-aloud engine (Kitten when installed, else system
  voices; a local voice that fails falls back to the system one) once the floor is free, holding the microphone and
  the turn-taking floor while it plays (plus echo tail), then tells Live what was said as quiet context, as data.
  `run_agent` tells the model not to read the answer out. Read-aloud of an agent's own chat uses its voice.
  `voice_engine_status.runtime.lastLine` records the last such line and its voice.

Tests: unit `storage/lib/personalities/__tests__/voices.test.ts` (10: migration, per-engine resolution, layering,
system pick, built-ins distinct and never Ava's, overrides, Live setup voice), `background/voice/__tests__/
manager-voices.test.ts` (8: Live setup voice from the personality, restart on switch with new instructions and
once only, no restart for the same voice, economy voice change, agent line in Live and economy, hand-off answer
from the watch), `background/agents/__tests__/voices.test.ts` (6: agent personality prompt, validation/diff/
authoring keep, voice layering and fallback, name prefix, templates distinct), `offscreen/__tests__/lines.test.ts`
(4), `stt/__tests__/economy.test.ts` (+2). Full suite 1552. E2E Brave `e2e/voices.e2e.mjs` (3: Live setup is Puck
for the engineer, `set_personality` → a fresh session with Charon, the accountant's instructions and a greeting;
the Research agent from the team template, its editor shows the inherited voices, `run_agent` by voice → the
answer is played as "Research: …" with Kitten `Leo` and Live gets it as context, not a notice; a built-in's Live
voice changed in Settings is stored), plus `voice`, `personalities`, `agents`, `voice-engines`, `speak`,
`voice-thread`, `inbox`, `ava-hub` green. Needs ears: the five built-ins and two agents on each engine, the pause
when Live reconnects, and whether the system-voice picks exist on Avi's Mac.

### Settings on one full page, grouped; install before use (2026-10-19)

Avi: Settings was one long list in the panel (8 built-in sections and 9 registered ones) with a second, different copy
of half of it on the options page. Now the options page is *the* Settings, and anything that needs installing asks
first.

- **One full page, by page.** `options.html` has a left nav of pages (General, Models, Voice, Personalities & agents,
  Memory, Connections, Meetings & brief, Privacy & safety, Help) and hash routes: `#voice`, `#voice/engines` (a
  section's id without the page prefix), `#models/local` (an anchor no section owns goes to the page's first
  section: here the Models hub's tab). Back/forward walk pages; a deep link scrolls to the section and focuses it.
  Content is at most 760 px, section cards in glass, a sticky page title, a search box (labels, page names and a
  `keywords` field per registration) that shows matching sections from every page; under 768 px the nav becomes a
  row of chips. `src/options/Options.tsx`, routing `src/side-panel/settings/pages.ts` + `src/options/useSettingsRoute.ts`.
- **Everything is a registered section.** `registerSettingsSection` gained `page`, `keywords` and `bare`; the nav and
  each page come from the registry. Settings' own sections are one component per setting in
  `src/side-panel/settings/sections/` registered from `settings/register.tsx` (names, look, writing style, confirm
  before, spending, highlights, browser-agent limits, Models, wake word, what joins memory, agents' memory,
  export/import/wipe, Connectors (a link: they stay in the panel), Obsidian, Calendar, Meetings, Morning brief,
  Firewall, Skills, Things to install, How do I…). The old `options/components/GeneralSettings.tsx`,
  `KnowledgeSettings.tsx` and `ModelSettings.tsx` are gone; their settings (max steps, vision, planning interval,
  page-load wait, replay, summary minutes, keep audio, export/import/wipe) live on in those sections with the same
  storage keys. The other streams' registrations got their page (About you, AI history → Memory; Voice and language,
  Read aloud, Voice engines, Audio devices → Voice; Inbox → Meetings & brief; Nex Brain → Connections).
- **The full page's PanelApi.** `createSettingsApi` (`src/options/settingsApi.ts`) sends over the settings port
  (`createPortClient` in `side-panel/models/transport.ts`); the background's handler moved from `models/register.ts`
  to `src/background/settings/port.ts` and takes only the prefixes settings sections send (`models_`,
  `voice_engine_`, `voice_models_`, `voice_preview`, `audio_devices_`, `brain_`, `identity_`, `memory_`,
  `history_`, `inbox_watch_now`), only from extension pages (not content scripts, not an extension page framed in
  a web page). `go`/`openThread` stay on the page for settings places, else open the side panel there (pending place
  in `storage.session`, `chrome.sidePanel.open` from the click).
- **Side panel Settings** is five quick ones (wake word, read aloud, active personality, model in use, look), each
  with "more" to its place on the full page, and "All settings". `openSettingsPage(hash)`
  (`src/shared/lib/settings-page`) reuses an open Settings tab (moves its hash, focuses it) or opens one. "Manage
  personalities" and Ava's `open_place` for a section go there too: the panel catalog now sends every registered
  section with its `hash`, derived from the registry (the hand-copied list is gone).
- **Install before use.** `src/side-panel/requirements/`: a requirement is `{ id, label, sizeBytes?, isReady(),
  install?(onProgress, signal), steps?, link? }`; `createRequirementFlow().choose(requirement, save)` saves at once when
  ready, else asks with a small card ("Needs Kokoro 82M, 97 MB — Install / Cancel"), shows progress with Cancel, and
  saves only once `isReady()` is true after the install; Cancel (or a later choice) keeps the old one; steps-only
  requirements get "Check again". Catalog: voice models (the existing downloads), the wake word (what
  `voice_models_needed` says), Ollama models (`POST /api/pull` streamed from the page, layers summed into one
  progress; with no server answering: steps to start Ollama or get the model in LM Studio's Discover tab), the
  embedding model (`nomic-embed-text`, and Ollama added in Models), a local chat model for economy voice, Nex Brain
  (pairing steps) and Obsidian folder access (the Brave flag). Used by Voice engines (speech-to-text, Moonshine size,
  text-to-speech, economy text model "On this computer"), Read aloud's engine, the wake word switch (panel and full
  page), Memory's "search by meaning with Local", Models › Local's recommendations (Install next to the copy
  command) and Help › Things to install. A choice already saved whose piece is missing says so under it (economy
  local, local embeddings) instead of failing later. Options that need installing read "· Install (97 MB)".

Tests: unit `side-panel/settings/__tests__/pages.test.ts` (registry by page, hash parse/build, slugs, anchors,
search), `side-panel/requirements/__tests__/flow.test.ts` (7: ready saves at once, save only after install, cancel
mid-install, failed install and still-missing, check again, a later choice drops the earlier, failed save shown),
`requirements/__tests__/ollama.test.ts` (pull lines, summed progress, streamed pull, errors, roots and names),
`background/settings/__tests__/port.test.ts` (allow-list, senders, refused commands never dispatched). Full suite
1650 green. E2E Brave `e2e/settings.e2e.mjs`: every page from the nav with its sections and one control each,
`#voice/engines` deep link with focus, back/forward, `#models/local`, search across pages, 400 px without
sideways scroll, panel quick settings and "more"/"All settings", Kokoro not installed → card, Cancel keeps System,
Install downloads (mock catalog) and only then saves, a recommended model pulled from a mock `/api/pull` with
progress. Moved UI fixed in `models`, `voice-engines`, `personalities`, `identity`, `companion`, `inbox`, `history`,
`kb`, `ava-hub`, `voice-download` (skips in a build that packs the models).

### Google Meet notes, made reliable (2026-10-19)

Owner's report: "Sometimes the recorder works if I click to record. The meeting card shows the meeting is recording,
but it's not actually working." The card read "Taking notes on this call · From the call's captions only", and
"Record audio" answered "Click the Nex Copilot icon… then press Take notes again".

Root causes, from the code:

- **"Recording" with no source.** Auto-notes start on captions (the tab was never invoked). The captions button was
  pressed only if its English name was "Turn on captions", the result was never checked, and the reader looked for
  `div[jsname="tgaKEf"]` or any `[jsname]` inside `[aria-label="Captions"]` (an old class name, and a selector that
  also matches the speaker's name and every wrapper). Whatever happened, the card, the meeting view and the header
  said "Taking notes" / "Recording · m:ss". The alert came only after 90 s and only for captions-only meetings.
- **Non-English Meet.** Being "in the call" was judged by a Leave button named in English. In any other UI language
  notes never started on their own, and leaving was never noticed.
- **Audio with no Gemini key.** The transcriber fell from the speech-to-text setting to Gemini Flash to the agent's
  chat model, which usually cannot take audio: every chunk failed or retried forever, the transcript stayed empty,
  and nothing alerted (the check skipped audio meetings). The local recogniser (Moonshine/Whisper/Vosk, on by default
  for voice since 10-17) was never used for meetings.
- **Lost mid-call.** The caption reader was injected once; a page reload or a lost worker left nothing reading. The
  tab's audio ending (a reload, a device change) ended the whole meeting even though the user was still in the call.
- **Record audio could not work.** Chrome hands over a tab's audio only after the user invokes the extension on that
  tab (toolbar icon or Alt+Shift+M); a button in the panel is not that, and the error told the user to "press Take
  notes again", which does nothing for a running meeting.
- **Silent summary failure.** A failed note set `status: 'failed'` and nothing else: no notification, no Inbox item,
  and with the panel closed the user never knew.

Now:

- **One place for Meet's page** (`meetings/captions.ts` `CALL_DOM`): accessible names in the shipped languages and
  more (en, pt, es, fr, de, it, zh, ja, ko), Material Symbols icon ligatures that do not change with the language
  (`closed_caption_off`, `closed_caption`, `call_end`), Meet's "Captions" live region, then class names only as a
  last resort; old selectors and the Zoom/Teams lines still work. Page functions take it as an argument (they run
  from source text).
- **Captions are turned on and checked**: `ensureCaptionsOn` presses the captions button (by name or icon, else
  Meet's `c` shortcut), waits up to 4 s for them to show, and stores `captionsOn`; if they cannot be turned on the
  meeting carries `captions_off`. Every 30 s `keepCapturing` reads the page again: puts the reader back after a
  reload, presses the button again if captions went off, records what it saw.
- **A reader that keeps up with Meet** (`watchCaptions`): one line per speaker turn (name and words), sent once the
  turn stops changing; a long turn is sent in parts; Meet dropping the oldest words or revising the last ones
  continues after the words already sent (`captionDelta`, the same code in the page, checked by a test); a turn that
  leaves the screen before it settles still counts.
- **Never "recording" without a source**: the meeting view says "Waiting for the first captions", "Not taking notes:
  the call's captions are off", or "Recording · m:ss · no words yet"; the card's title is "Not taking notes yet" /
  "Waiting for the first words" until words arrive; the header pill is grey and still until then (`status.ts`).
- **Loud alert, sooner, with the reason** (`JoinFlow.checkCapturing`, default `nothingCapturedSeconds` 90 → 45):
  captions not confirmed on → alert after 45 s; captions on but none → after 2 min (nobody may have spoken); audio
  with no chunk at all → 45 s; audio whose chunks fail → 45 s. Notification that stays, Inbox alert, Ava. The
  warning clears when words arrive.
- **Audio is written down without a key**: `transcriptionRoute` (`meetings/capture.ts`): speech-to-text setting →
  Gemini Flash (with a key) → the installed local recogniser through the offscreen `stt_transcribe` → the agent's
  model last.
- **Audio lost mid-call** → the same meeting goes on from the captions (`audio_lost` warning and alert, "click the
  icon to record again"); only a closed tab or a tab off the call ends it.
- **Record audio** that cannot work brings the call tab to the front and says exactly where to click
  (`meeting_needsInvokeAudio`); the toolbar click or Alt+Shift+M on the tab upgrades the same meeting
  (`MeetingManager.addAudio`), never a second one.
- **Leaving ends the notes in seconds**: the page itself reports `meeting_call_left` when Meet shows "You left the
  meeting" or the Leave button has been gone ~12 s; the background reads the page once more and stops. The 30 s check
  stays as the backstop (`leftCall`: the left screen at once, else three misses). Notes stop and the summary is written
  in the background, with the panel closed.
- **Summary failure is loud and retryable**: `note_failed` warning, a notification that stays, an Inbox alert; the
  panel shows a card with Retry wherever the user is (for a day), and the meeting view has Retry; a later success
  clears the warning and marks the alert done. The model call already falls back to the local model
  (`callWithFallback`).

Tests: unit `meetings/__tests__/capture.test.ts` (14: transcription route incl. local with no Gemini key, local
clip placement, audio-ended decision, keep plan, leave verdicts), `captions.test.ts` (9: caption delta incl.
dropped/revised words, the page copy is identical, labels in en/pt/zh, region name exact, left screen),
`join-flow.test.ts` (+2, reasons), `side-panel/meetings/__tests__/status.test.ts` (2). Full suite 1677 green.
E2E Brave `e2e/meeting.e2e.mjs` 10/10 on a Meet-shaped fixture (toolbar with icon ligatures, captions OFF at start,
a "Captions" region with growing speaker turns, "You left the meeting" screen): captions off → the extension turns
them on once → whole turns arrive once each with the speaker; a call with no captions control → "Not taking notes
yet", never "Taking notes", alert → toolbar click → audio on the same meeting, words arrive, one meeting; leaving
with the panel closed → summary with action items in under 30 s; a failing summary → Inbox alert, notification,
panel card → Retry writes it and the alert is done. `voice` 6/6 (call control uses the new page reader).

Needs a real call to confirm (no Google sign-in was used): Meet's current captions region, block and speaker markup;
that the captions button carries the `closed_caption_off` ligature and an accessible name in the user's language;
that a synthetic click turns captions on; how long the Leave button can be missing during layout changes; whether a
Meet reload ends the tab capture (then `audio_lost` takes over). Meet's caption *language* is Meet's own setting and
is left alone. Users with saved meeting settings keep their old `nothingCapturedSeconds`. Design for Ava speaking in a
call: `docs/meet-voice-plan.md` (not built).

### Cancel settles; dictation never loses its answer (2026-10-19)

**Cancel on a confirm card left the chat stuck** ("Task cancelled", then still "Working on the page" and the red
Stop). Cause: `ThreadManager.answer` wrote `status: 'running'` *after* awaiting its "Cancelled: …" note, while a
refusal stops the task at once (`review.ts` → `context.stop()`), so the run's own end (`idle`) could land first and be
overwritten. Second cause, found by the E2E: a run that stopped itself was parked, so the next message reused the
stopped agent and ended at once as "Task cancelled". Fix (`threads/manager.ts`): `answer` issues its writes before
the agent resumes and only while the run is live; events are recorded one at a time and the run's end waits for them
and is the last write (the thread is released only after it); nothing recorded after the end or after a stop can set
activity, a request or `waiting_confirm`; a run that reported TASK_CANCEL is never parked; `cancel` is idempotent, and
settles a thread that looks busy with no run behind it; a message, Continue or Retry sent while a stopped run winds
down waits for it (≤ 5 s) instead of "busy"; a hung debugger detach no longer holds the end (5 s).

**Dictate-and-send showed Chrome's "message channel closed before a response was received".** Cause: local
transcription runs in the offscreen document, but nothing told `closeOffscreenIfIdle` it was busy, so the wake word's
minute check (wake word off), the end of a conversation or an audio check closed the document mid-request. Fix
(`voice/dictation.ts`): a `dictation` offscreen-busy check while a recording is written down; one retry when the
messaging channel broke (pure work); `sttErrorMessage` turns Chrome's wording into a plain sentence. The panel keeps
the recording and offers **Try again** (`useSpeechInput` `retry`/`canRetry`); a send the background refuses or never
hears (port lost) puts its words back in the composer (`side-panel/chat/pendingSends.ts`). Listener audit: every
`onMessage` that returns `true` now answers on every path — offscreen router and local-voice listener (a throwing
command), `kb_vault_remove`, `capabilities_panel`, and the one-off `memory_`/`workflow_`/`history_` commands through
the new `answerOneOff` (a handler that throws or never replies). The settings port and the panel port answer a
throwing command too. Locale keys `chat_stt_unanswered`, `chat_stt_retry`, `chat_send_kept`.

Tests: `threads/__tests__/manager.test.ts` (cancel from the card, Stop on a question, late events, double cancel,
stale busy thread, send right after cancel, fresh agent after a refusal), `voice/__tests__/dictation.test.ts`,
`registry/__tests__/registry.test.ts`, `side-panel/chat/__tests__/pendingSends.test.ts`. E2E Brave: `gate` 13/13 (new:
Cancel settles and the next message runs; Stop on a question, twice), `dictation` 6/6 (new: Send when transcribed on
the device while the close is asked for every 100 ms — fails with the busy check removed; Gemini send-when-transcribed
asserts one message, no error; Try again after a failed transcription), `voice` 6/6, `threads` 8/8.

### Ava speaks in Google Meet, as her own participant (2026-10-20)

Option A of `docs/meet-voice-plan.md`: a dedicated account (e.g. `ava@nexprove.com`) that the user signs in to by
hand joins the call as a separate participant. The Voice rule "never into a call" now reads: never into a call
except as her own, named participant, for words the user approved with a click.

- **Nex Brain** (`companion/src/meet`): starts the installed Chrome, Brave or Chromium with its own profile
  (`<data dir>/meet-profile`), no extensions, `--mute-audio` (no echo from the Mac's speakers), a silent fake capture
  file, and the debugging **pipe** (no port any other program could drive). Before any page script,
  `MIC_SCRIPT` replaces `getUserMedia` in that browser only: audio is a Web Audio destination the companion plays
  WAV clips into, video a black frame. `MeetBot`: idle → joining → waiting_admission → in_call → left / failed(reason);
  presses Join/Ask to join by name (camera off, mic on), gives up after 10 min unadmitted, leaves on call end, removal,
  a closed window or `leave`. Sign-in opens accounts.google.com **without** the debugging pipe (nothing drives that
  window) and checks the sign-in once it closes. Only `https://meet.google.com/<code>` is ever opened
  (`normalizeMeetUrl` in the shared protocol). Routes `/v1/meet/{status,signin,join,say,stop,leave}` with pairing auth;
  `say` is capped at 7 MB base64 and refused for any call but the one the words were approved for.
- **Extension** (`src/background/meet-voice`): commands `meetvoice_*`; the `say_in_meeting` action and voice tool,
  `stop_speaking_in_call` (unguarded: it can only quiet her) and `remove_ava_from_call`. `say.ts` holds the rules:
  attended chats only, a user request in this turn, she is in the user's call, the words are not lifted from the
  captions/transcript, the confirm card with the exact words every time (whatever the gate settings say), a one-line
  introduction the first time in each call ("Hi, I'm Ava, an AI assistant speaking for …"). By voice the request is
  checked against what was heard, then handed to a chat where the card waits. `render.ts` makes the WAV in the
  personality's voice: Kitten/Kokoro through the new offscreen `local_tts_render` (`LocalTts.render`), Gemini with its
  key; the system voice cannot render, and with no engine she refuses plainly. She leaves when the call page reports
  the user left (`meeting_call_left`) and, as a backstop, a one-minute job when the notes end.
- **Panel**: `AvaInCall` in the Meet notes view (paired only): Bring Ava into this call / Ava leaves / Stop, a state
  line, "Sign Ava's browser in". Esc stops her anywhere in the panel. The consent reminder mentions her.
- `ask_meeting`'s answer to the voice model is now wrapped as untrusted (it is made from what the call said).
- Not built: recording or captions by her, auto-approved short answers, locales other than English for Meet's buttons.
- Security review fixes (same day): the user's own words this turn must ask her to speak to the call (`askedToSpeak`;
  by voice, what was heard); words copied from the call are refused however short, and the call text now includes
  what the user's Meet page shows (chat, pop-ups), read in the isolated world. The introduction is keyed by join
  session (`code@since`) and cleared on join and leave, so a rejoin or next week's meeting on the same link gets it
  again. `READ_STATE` trusts the exact "Leave call" control first and reads end screens only with chat, captions,
  participant lists and other writable regions cut out. A sign-in check never closes a browser a join started (join
  waits for it), and a call browser that exits always ends in left. Calls use the on-device voices first; Gemini is
  the last resort, sent a fixed read-aloud-exactly instruction with the words quoted.

Tests: companion `meet.test.ts` (addresses, launch flags, join/admission/denied/ended/removed/closed, say only in the
approved call, stop, sign-in, routes with auth and size caps), opt-in `live-mic.test.ts`
(`AVI_BRAIN_LIVE_BROWSER=<browser>`: a played clip reaches a local page's `getUserMedia` stream, stop silences it —
passed on Brave and Chrome); extension `meet-voice/__tests__/say.test.ts` (origins, request, other call, words from
the call, gate every time, intro once per call, stop bypasses the breaker, render fallbacks), `local-tts.test.ts`
(render without playing, stop cancels).

### Ava on WhatsApp, through Nex Brain (2026-10-20)

Avi asked for Ava to message him and read his messages on WhatsApp now, with an unofficial WhatsApp Web client, and
accepts the risk; this replaces the Cloud API plan (`docs/whatsapp-plan-b.md`). Plan A (`src/background/whatsapp`,
Ava inside his own WhatsApp Web tab) is unchanged.

- **Client:** `@open-wa/wa-automate` 5.6.6 in the companion (he named it; maintained; text send/receive and
  QR login need no licence key). Baileys was the alternative and was ruled out: QR pairing has been broken in every
  release since 2026-07-28 (WhiskeySockets/Baileys#2737, fix unmerged). open-wa drives real WhatsApp Web in its own
  headless Chrome/Brave/Chromium, so WhatsApp's own pairing code runs. Loaded on first link only.
- **Companion** (`companion/src/whatsapp`): `WhatsAppService` keeps the session under `<data>/whatsapp/session`
  (0700) and `state.json` (0600). Owner only: the linked account's "Message yourself" chat, plus one other number of
  his when Ava has her own number (a chat in `@lid` form counts only when the message shows that number). Every other
  chat is dropped before anything is kept or logged; `sendTo` refuses any other chat; groups, broadcasts and
  newsletters never count. Text is queued (dedupe by id, 50 max, 7 days), media gets "I can only read text for now",
  her own sends coming back in the self chat are recognised (id or words). No pull for 2 minutes → the owner hears
  once "Your browser is closed…" and the message stays queued. At most 20 sends an hour. Routes
  `/v1/whatsapp/{status,link,unlink,owner,inbox,ack,send}` (pairing auth); `send` takes no recipient.
- **Extension** (`src/background/whatsapp-remote`): polls `inbox` every 5 s while the worker runs and on a 1-minute
  job; messages go into one chat a day (`WhatsApp · <day>`, origin `'whatsapp'`, its own background tab) as one
  turn, acked after the turn starts. A running chat keeps them queued; a chat waiting for a click says so once. When
  the turn ends the answer goes back as WhatsApp text (`format.ts`: no tables, `*bold*`, ≤3000 chars). Approvals in
  that chat reply `That needs your click in the browser: <what>`; nothing is ever approved from WhatsApp.
- **Origin `'whatsapp'`:** always asks before a commit (`gate/origins.ts`, used by `reviewAction` and Drive), not
  attended for hand-offs or `say_in_meeting`, no connector set-up (sign-ins), voice speaks up only when it waits for
  a click. Facts and memory scope stay the user's (his own words).
- **Ava messages first** (`src/background/notices`: `emitNotice` from the brief, routine `out.inbox`/`out.notify`;
  Dexie hooks for chats waiting for approval and meeting notes done). Per-kind toggles and quiet hours (22:00–07:00;
  approvals still go) in Settings › Connections › WhatsApp, which also shows the code (inline QR encoder,
  `side-panel/whatsapp-remote/qr.ts`, checked module for module against Arase's encoder), the state, the other
  number, a test message and Unlink. Not paired → it points to Nex Brain's setup.

- **Security review fixes:** open-wa fetches live patches (obfuscated scripts it injects into WhatsApp Web) from
  `cdn.openwa.dev` / GitHub with Node's fetch on every launch. `companion/src/whatsapp/harden.ts` guards the
  process fetch: those addresses get the vendored, sha256-pinned set (empty: the bundled `wapi.js` has sendText,
  getMe and the listeners, and open-wa goes on without remote patches), every other open-wa host is refused, a
  mismatched pin fails closed; `cachedPatch`/`ghPatch` off, `blockCrashLogs` on. Its Puppeteer driver is wrapped:
  debugging pipe instead of a random local port, `--ignore-certificate-errors*` dropped, open-wa and WhatsApp
  telemetry hosts unresolvable. Forwarded messages are never queued ("I only act on messages you type
  yourself…"). Her sends carry an invisible mark and are remembered by id and words for 30 days on disk; messages
  dated before the session became ready (history sync) are ignored. Quiet hours are held by Nex Brain too
  (`/v1/whatsapp/quiet`; only replies and approvals go). Changing the owner purges queued and remembered chats that
  are no longer his. Notices carry no page text: the brief sends counts only, approvals the chat name and the kind
  of action, routine and meeting text is one line each, links stripped, capped. WhatsApp chats never read aloud,
  never use an incognito window, and may run but not create or change agents and routines (`gate/origins.ts`:
  `alwaysAsks`, `userAtComputer`, `configRefusal`, `runRefusal`).
  If a future WhatsApp Web build needs open-wa's remote patches, linking or sending will fail rather than run
  unreviewed code: vendor a reviewed patch file and update the pin.

Tests: companion `whatsapp.test.ts` (owner-only receive, nothing kept of other chats, send refusal, dedupe and echo,
queue/ack and reply routing, @lid rule, media, browser closed, hourly limit, unlink, routes); extension
`whatsapp-remote/__tests__/{bridge,format}.test.ts` (turns, busy and waiting chats, answers once, commit held,
approvals in quiet hours, toggles, meeting notes, origins), `side-panel/whatsapp-remote/__tests__/qr.test.ts`,
`say.test.ts` (WhatsApp refused).

**More than text (#18, 2026-10-26).** Baileys gives each message's file details, caption and link preview; the
service downloads a file only for the owner's own, typed (not forwarded) messages, capped per kind
(`WHATSAPP_MEDIA_MAX_BYTES`: voice 16 MB, photo 10 MB, document 25 MB, refused before download when WhatsApp's own
size says so). A voice note's or photo's file waits in `<data>/whatsapp/media` (hashed name, 0600) until the ack; a
document is kept in `<data>/whatsapp/files` (1 GB in all, oldest go) and read on the Mac by `whatsapp/documents.ts`
(PDFKit through `osascript`, `textutil`, `unzip` for xlsx/pptx; path always an argument, time limit, output cap).
`POST /v1/whatsapp/media` gives a queued message's bytes or a document's text to the paired extension only. Video,
stickers, locations and contacts get a plain answer and nothing is kept. In the extension, `bridge.turnOf` makes one
turn: a voice note written down on this computer (`transcribeLocalFirst`: Moonshine/Whisper, Gemini only when no
local model is installed) as "(voice note) …"; a photo as a chat attachment (`whatsapp-remote/media.ts`), its caption
the question; a document saved to the knowledge base in the chat's workspace with "Got Quote (PDF) (1.2 MB)…" sent
back, its text going with a question as content only; a link as his words plus its preview as content, with the
instruction to open it and `read_page_text`. Content rides in `ThreadManager.send({ context })`, which the model reads
after the words (`withContext`) and the chat does not show. File names said back on WhatsApp go through
`plainOutside` as "Quote (PDF)". Tests: companion `whatsapp.test.ts`, `whatsapp-baileys.test.ts`,
`whatsapp-documents.test.ts`; extension `bridge.test.ts`, `media.test.ts`, `dictation.test.ts`; e2e
`whatsapp-media.e2e.mjs` (the voice-note eval: a real recording through the local recogniser, skipped without one).

### Memory and settings survive an uninstall (2026-10-21)

Uninstalling wipes IndexedDB, `chrome.storage` and OPFS; Nex Brain's data dir does not, and the pinned manifest key
keeps the extension ID. So Nex Brain keeps backups (`companion/src/backup/`, routes `BACKUP_ROUTES` in the protocol,
auth `api` like the rest of /v1): gzipped snapshots sent in 4 MB parts and checked by size and SHA-256 at commit,
files 0600 in `backups/` (0700), the last 14 kept plus the newest of each day for 30 days, 256 MB cap.

- **What is in a snapshot** (`src/background/backup/snapshot.ts`): every table of the database, found by listing
  `db.tables`, and every `chrome.storage.local` key, minus two short deny-lists there (tables: `logs`,
  `audioChunks`, `modelCatalog`; keys: pairing and health of Nex Brain, the backup's own status, live call state,
  caches). Not in it: `chrome.storage.session`, OPFS voice models, the Obsidian/AI-history folder handles, the
  vault's database. Embeddings are kept (they cost model calls). Blobs and byte arrays travel tagged in the JSON.
- **Keys** never go in a snapshot: with "Include API keys and sign-ins" on (default), the vault's entries (all but
  the pairing token) go to `/v1/backups/secrets/put`, which encrypts them (AES-256-GCM) under a random key kept in
  the macOS Keychain (service "Nex Brain backup"), passed to `security -i` on stdin. Off removes the copy on the Mac.
- **When**: `backup_auto` job 2 min after the last change (Dexie hooks, `storage.onChanged`), at most 10 min after
  the first, never within 10 min of the last backup; `backup_daily` at 13:00; one a minute after browser start.
  Skipped while not paired or before the first-run setup is done (a fresh install never uploads an empty snapshot).
- **Restore** (`restore.ts`): full replace in one Dexie transaction, then storage (this install's pairing kept), then
  keys; an older snapshot is written into a scratch DB at its own version and opened as today's so Dexie runs the
  real upgrades; a newer one is refused. Then `chrome.runtime.reload()`. From the first setup screen on a fresh
  install ("Restore from Nex Brain on this Mac": find it, pair with the code, pick, confirm) or Settings › Memory ›
  Backups. Export/Import in Settings › Memory now write and read the same snapshot as a `.json.gz` file (no keys;
  the old knowledge-only export still imports); an imported file is size-limited, gunzip-capped and zod-checked,
  and reaches the background through OPFS.
- **Review fixes** (`trust.ts`): secret-named fields (apiKey, token, accessToken, refreshToken, secret, password,
  clientSecret, authorization, cookie…, any case, nested) are emptied in every row and storage value of every
  snapshot. A file restore is untrusted: firewall, gate, skills and workflow settings and the approved tool pins
  (`toolFingerprints`) stay as they are; a provider whose type/baseUrl differs from the current one (or its known
  default) loses `keyRef`/`hasKey`; a connector whose server changed asks for sign-in again (its vault entries are
  deleted) and tool policies are always this browser's. The import confirm says "Only import a file you exported
  yourself." Jobs are never restored (excluded and cleared); recovery schedules them again: workflows and agents
  from their records, and now Inbox snoozes too (`rescheduleSnoozes`). Test: `backup/__tests__/trust.test.ts`.

Tests: `src/background/backup/__tests__/backup.test.ts` (coverage of every table and store key, round trip,
full replace, migration through a real upgrade, newer refused, keys apart and toggle, debounce),
`size.test.ts` (realistic fixture: 75 MB JSON → 31 MB gzipped), companion `backup.test.ts` (auth, chunks,
damaged/oversized/out of order/non-gzip, retention, Keychain on stdin, file modes), E2E `e2e/backup.e2e.mjs`.

### Obsidian and the calendar through Nex Brain

Neither had ever connected for Avi (Brave on macOS). The browser folder picker is off in Brave, its permission is asked
again each session, and the handle is lost on reinstall; the iCal scrape opened `/u/0` only, read English labels, and
waited four minutes when a Workspace admin had turned secret addresses off. With Nex Brain paired both now go through
the Mac:

- **Obsidian** (`companion/src/obsidian/`, `OBSIDIAN_ROUTES`): vaults from Obsidian's `obsidian.json` or a typed path
  (must be a directory with `.obsidian/`, realpath'd, kept in `<dataDir>/obsidian.json`); notes listed (paged,
  `since`), read in batches of 50, written (temp file + rename, `create` never replaces, `overwrite` only a note whose
  front matter carries the marker), removed (marker only), searched (names then text, capped). Every path is a
  relative `.md` path without `..`, hidden parts or control characters; no symlink may lead outside the vault and
  writes never go through one. The extension's `src/background/obsidian/` syncs exactly as the browser folder does
  (`sync.ts`: memory out to `Nex Copilot/`, the user's changed notes into the KB, deleted ones out), every 10 minutes
  as a job, and chooses the vault again from its path when Nex Brain lost it. The choice is the `obsidian-vault`
  setting, so a Nex Brain backup restores it; a backup file never sets it (`FILE_KEEP_STORAGE_KEYS`). The card
  (`vault/BrainVault.tsx`) shows "Your vaults" + "Other folder…" when paired; the browser picker and Brave's steps
  stay for unpaired.
- **Calendar** (`companion/src/calendar/macos.ts`, `CALENDAR_ROUTES`): EventKit through `osascript -l JavaScript`
  (shell-free runner), status (`granted`, `not_determined`, `denied`, `write_only`, `restricted`, `unavailable`),
  the one-time prompt (`request`), events in a ≤32-day window (≤500, notes ≤2000 chars, join link extracted with the
  shared `meetingLinkIn`). The watcher reads from `sources.ts`: the Mac first when paired and on, the iCal address as
  fallback; one failed read keeps the day's events. The card (`side-panel/calendar/MacCalendarCard.tsx`) shows the
  permission steps, "Allow access", the calendars by account with checkboxes, and the Internet Accounts note. The
  iCal path gained an account choice (`/u/0`…`/u/4`), plain errors for 404/403/non-feeds, and says within ~6 s that
  secret addresses are off (English pages only).

Security review fixes: Nex Brain writes and removes only under `Nex Copilot/` (any case; schema and companion both
check), the marker (`OBSIDIAN_MARKER`) is fixed and always required to replace or remove, vault roots refuse `/`,
home and its ancestors, `~/Library/**`, system folders and hidden folders (home compared by realpath), and a sync
re-chooses the saved path only when Nex Brain has none chosen and the path is still the same vault id
(`expectVaultId`); otherwise it stops with "Choose your vault again", so two browsers never undo each other.

Tests: companion `obsidian.test.ts` (discovery, confinement: `..`, symlink escape, absolute, encoded; limits; marker;
routes), `calendar.test.ts` (osascript output, permission states, denied, off-macOS, routes; osascript is always
mocked); extension `obsidian/__tests__/sync.test.ts`, `calendar/__tests__/{sources,connect}.test.ts`,
`vault/__tests__/brain.test.ts`, `calendar/__tests__/macCalendar.test.ts`; E2E `e2e/brain-connect.e2e.mjs` with the
mock companion.

### "Update available"

Chrome never auto-updates an unpacked extension, so "update" here means: tell the user plainly, and make updating
one step. The install story already supported that half (`site/public/install.sh` re-downloads into the same
folder and overwrites it — re-running the installer *is* the update; only "Reload the extension" is new), so this
adds the checking and the telling.

- **The feed**: `site/src/pages/version.json.ts`, a static Astro endpoint (same pattern as `llms.txt.ts`,
  `robots.txt.ts`) served at `https://nex-copilot-one.vercel.app/version.json`. It reads `VERSION` (the repo's own
  `package.json`, already imported by `site.ts`) and the companion's `package.json` version directly — no separate
  script, no extra build step, built by the ordinary `pnpm build` (Astro). The only two fields anyone edits by hand
  are `released` and `notes`, in `site/src/content/release-notes.ts`; **bump them alongside every real version bump**
  (`pnpm update-version`), then push — Avi's existing Vercel deploy on push publishes the new `version.json`, nothing
  else to run. Nothing here touches `site/public/download/` (the separate, git-ignored release zip from
  `scripts/release.mjs`); the two are unrelated artifacts that happen to live on the same site.
- **The check**: `src/background/update/` — `schema.ts` (zod, every string length-capped), `semver.ts` (plain
  `x.y.z` compare, no pre-release handling needed), `check.ts` (`credentials: 'omit'`, no identifying headers, an
  `AbortSignal.timeout`, a size cap by `content-length` and by actual bytes read), `state.ts` (two `createStorage`
  stores: a setting and a status, the same shape as `companion/state.ts`), `register.ts` (the job, the three
  commands, the toolbar tooltip, the one-per-version notification). A job (`src/background/jobs/runner.ts`) runs it
  every 12 hours (`registerRecovery` re-arms the cron on every background start) plus once near a real
  `chrome.runtime.onStartup`/`onInstalled` (not every service-worker wake, which would be far more often than "at
  browser start"). Nex Brain's own version comes from `brainStatusStore` (already known when paired and online) and
  is compared the same way, but only shown, never a separate notification. "Check for updates" (Settings › Help,
  default on) is the setting that keeps CLAUDE.md's "no third-party calls" honest: this is Nex Copilot's own site,
  explained in the section's hint, and "Check now" always works even with the setting off.
- **Telling the user**: a dismissible banner in the panel (`src/side-panel/update/UpdateBanner.tsx`, shown on
  Home/Chat only) with "What's new" (expands the notes inline) and "Update" (opens Settings › Help's `#updates`
  anchor); a dot on the Settings › Help nav item (`src/options/Options.tsx`, both the desktop nav and the narrow-
  window chips) when an update is available; one `chrome.notifications` notification per new version
  (`notifiedVersion` in the status store prevents a repeat). The toolbar uses its **tooltip**
  (`chrome.action.setTitle`), deliberately not `setBadgeText` — the Inbox already owns that badge
  (`src/background/inbox/badge.ts`) and the setup checklist was, at the same time, also starting to use it; the two
  features were told to use different mechanisms rather than race each other for one API.
- **The Settings section** (`src/side-panel/update/UpdateSettings.tsx`, registered as Help's `help-updates`,
  first in that page): the setting toggle, installed vs. latest version with "Check now", the expandable notes,
  the install command again (`CopyCommand`, reused from `models/LocalSection.tsx`) plus "Reload the extension"
  (`chrome.runtime.reload()`, called directly — reload is not state, so it doesn't go through the background), and
  the same install-command-plus-status pattern for Nex Brain.
- i18n: every string under `update_`, in all three locales; `node scripts/check-locales.mjs` passes.

Tests: `src/background/update/__tests__/semver.test.ts`, `check.test.ts` (schema rejection, oversized by header and
by body, non-OK, bad JSON, network failure — a fake `fetch`, no real network), `register.test.ts` (notifies once
per version, no second notification on a repeat check, toolbar tooltip on/off, Nex Brain comparison only when a
local version is known, the setting gate vs. "manual" bypassing it) with a small local chrome stub
(`__tests__/chrome-stub.ts`, the same idea as `companion/__tests__/chrome-stub.ts`). No E2E yet — the feed itself
needs a real or fixture `version.json`, which the existing E2E fixture server does not serve; worth adding if this
area grows.

**Pre-existing, unrelated**: `cd site && pnpm build` currently fails on this worktree (`Rolldown failed to resolve
import "@extension/storage" from .../Composer.tsx`) with or without this feature's two site files — confirmed by
removing them and rebuilding. Not caused by this change; left for whoever owns the site build to look at.
### Required setup: checklist, indicator, Ava's meeting account, local-only proof

Every part of the setup is a checklist item with a live check, a one-line reason and a button
(`src/background/setup`: `checks.ts` rules, `readers.ts` reads the real status, `register.ts` job every 15 min plus
storage-change checks, commands `setup_status|skip|unskip|open_app`; page `src/side-panel/setup`, section
`options.html#general/setup`). Required: a working model, a local model (Ollama/LM Studio with a chat model and
`nomic-embed-text`; one-click pull; once present it is set as the `local` role and `fallbackLocal.model` unless the
user chose one), on-device voice models, Nex Brain paired. Recommended (Skip, and Bring back): Ava's meeting account,
WhatsApp, calendar, Obsidian, a backup. The header shows a count (`SetupIndicator`), and the toolbar badge shows it
while the Inbox has nothing unread (`inbox/badge.ts`). Onboarding has a checklist step after the model step; Next is
never blocked by it.

Ava's meeting account: Settings › Meetings › `#meetings/ava` (Nex Brain state, signed in and as which account, Sign in,
Check sign-in) and "joins the Google Meet calls I join": Never (default) / Ask me / Always (`meet-voice/autojoin.ts`,
a Dexie `creating` hook on meetings). Ask is a notification plus a card in the call's notes; Always asks instead
when her browser is signed out; it never joins without the user's tab on that call. Nex Brain gained
`/v1/meet/check` (account read from Meet's account button) and `/v1/apps/open` (Ollama or LM Studio only, `open -a`).

Local only (Ollama + qwen3:4b, no cloud key): `models/__tests__/localOnly.test.ts` (chat, title and summary light work,
fallback, Ollama stopped gives a plain error) and `e2e/setup.e2e.mjs` (a full browser task on the mock Ollama, then
the checklist, Skip, header count and badge). Cloud-only today: Gemini Live Talk without local voices, a web-search
role (no local model has it), and vision on qwen3:4b (no screenshots sent).

### Ambient A1: Listen mode (2026-10-25)

Roadmap item 12, first milestone ([ambient-plan.md](ambient-plan.md)). Settings › Voice › Ambient: Off / Listen only
/ Companion (Companion behaves like Listen until A4). In Listen, the offscreen document holds its own microphone
stream (`src/offscreen/ambient/listener.ts`) and the scribe (`scribe.ts`) cuts it into utterances with the speech
gate and writes them down with the local recogniser from Settings › Voice engines (the smallest Moonshine on battery
under 30%). It pauses for a voice conversation, dictation and a recorded meeting. The background
(`src/background/ambient/`) files utterances into sessions (`ambientSessions` / `ambientUtterances`, Dexie v6, gap
10 min, kept 30 days) and obeys the spoken switches in `phrases.ts`, matched word for word, never by a model: "Ava,
just listen", "Ava, feel free to chime in", "Ava, go quiet", "(Ava,) off the record" / "back on the record", "Ava,
forget the last N minutes". Off the record the scribe still decodes, but only to hear "back on the record"; nothing
else leaves the recogniser. Listening shows as a dot on the toolbar icon (`indicator.ts`; the badge stays the
Inbox's) and an ear in the panel header.

Ambient text never reaches a model unless "Let the cloud model use what Ava hears" is on (off by default). Only then
are sessions indexed into the knowledge base as `sourceType: 'ambient'`, where the embedder, the graph and answers
read them like any other item. Turning it off removes them. A voice tool `set_listening_mode` changes the mode
(guarded like every registered tool).

Tests: `background/ambient/__tests__` (switches, manager: storing, switches never kept, off the record, forget,
retention, cloud permission), `storage/lib/ambient/__tests__` (sessions, forget, TTL),
`offscreen/ambient/__tests__/scribe.test.ts`, `kb/__tests__/chunk-ambient.test.ts`, and `e2e/ambient.e2e.mjs` (the
looping recording is written down by Moonshine with no POST to any model, the indicator, off the record, Settings).
Left for A2: voiceprints (every utterance is `speaker: 'unknown'`).

### Rename: Nex Copilot → Ava Copilot, Nex Brain → Ava Brain; ava.nexprove.com; feedback through GitHub (2026-10-25)

- Avi's call: the product is **Ava Copilot**, the Mac companion **Ava Brain**, the site **ava.nexprove.com** (the
  Vercel project keeps nex-copilot-one.vercel.app as an alias, so copies that still check the old address get
  updates), and the repository **AviOfLagos/ava-copilot** (renamed; GitHub redirects the old name), to be made public.
- Renamed every user-visible string (176 files): locales, UI, prompts, site content, installers, docs (README,
  PRIVACY, NOTICE, CONTRIBUTING, SECURITY, distribution, roadmap). Old planning docs and this log keep their history.
- Kept, as stored identifiers whose rename would lose data or break existing installs: the Obsidian folder
  `Nex Copilot/` (`EXPORT_ROOT`, `OBSIDIAN_WRITE_ROOT`: notes already live there), the backup format
  `nex-copilot-backup`, the Keychain service `Nex Brain backup`, the authoring prompt markers, the companion's
  built file `dist/nex-brain.mjs` (LaunchAgents point at it; `ava-brain`, `nex-brain` and `avi-brain` are all bin
  names for it), and everything the previous rename kept (IndexedDB names, `avi-copilot` markers, data dirs).
- Installers: new installs go to "Ava Copilot" / `ava-copilot`; an existing "Nex Copilot" folder with an
  installer marker is updated where it is, so the browser's Load unpacked path stays valid. Marker
  `ava-copilot-install.txt`, older markers still recognized; `AVA_COPILOT_BASE_URL`, older env names still read.
- Update feed: `src/background/update/check.ts` now reads https://ava.nexprove.com/version.json.
- Feedback: `.github/ISSUE_TEMPLATE` forms (problem, install problem, idea) whose field ids the extension fills in
  (Settings › Help › Report a problem, `src/side-panel/feedback`: version and browser, nothing sent until the
  user submits on GitHub); a pull request template; CODEOWNERS; `.github/workflows/ci.yml` (types, unit tests,
  locales, extension build, site build) on every pull request, read-only, no secrets. Removed `.github/FUNDING.yml`
  (it pointed GitHub's Sponsor button at Nanobrowser's author) and the upstream READMEs; new README.
- Version 0.2.1, so installed copies show the update notice.
- Known, not from this change: `companion/src/__tests__/sessions.test.ts` reads a spike recording deleted on
  2026-10-17 (631aa92) and fails; CI does not run the companion's tests.

### Do-once keys (2026-11-20, #64, docs/growth-team.md Part 2)

- Every step that sends, posts, submits, grants or creates writes a record before it acts ("started") and when its
  result is in ("done"): table `doOnce` (Dexie version 7, `src/storage/lib/once`), logic in `src/background/once`.
  The key is the task, what the step is, and a hash of what it acts on; no content is kept.
- Where it is checked: `gate/review.ts` (every commit on a page: `reviewAction` writes "started" last,
  `verifyCommit` / `settleCommit` close it) and `integrations/action.ts` (every connector tool that is not a plain
  read). WhatsApp sends and Drive create/share name their own step.
- A step that is done, or one cut off before its result was recorded, is not run again by itself: the model is told
  once, and a second try goes to the user on the confirm card, which says why (`ConfirmRequest.repeat`).
- A retry rarely words a message the same way, so the hash alone cannot tell a repeat. Two rules cover that: a
  cut-off step holds back every other commit on the same site or tool in its chat (also after "continue", which is a
  new task) until the user has seen a card about it; and in a retried or resumed run, a commit where an earlier run
  of the task already finished one goes to the user with a note, whatever the confirm settings say.
- A commit the page shows no sign of (`gate_verify_unknown`) is never called "done", and it is not treated as cut
  off either: it holds back only itself (`onceStore.unsure`), and a later run that sends there again is shown it. A click that commits is
  tried one way only (`Page.clickElementNode({ once })`): the fallback click could send twice.
- If the records cannot be read, the step is refused.
- The task id is `ThreadRecord.taskRunId`: new for every request (`ThreadManager.send`), kept through resume and
  retry. A run that picks a task up again is told what it already sent (`onceNote`).
- A tool whose schema has a string `idempotency_key` (or `idempotencyKey`) gets the key, so the far side can refuse
  a repeat too.
- Not covered here: routine (workflow) tool steps keep their own rule (a side effect cut off mid-call is
  `unknown_outcome`); `hand_to_agent`, `run_agent`, `run_workflow` and `say_in_meeting` take no key yet. The page key
  is coarse on purpose (site + what is filled in): the same words to two people in one chat app need a second try
  and the user's click.

### A closed tab does not end the task (2026-11-20, #65, docs/growth-team.md Part 1)

- `ThreadManager` keeps the last page and window of every bound tab (`onTabUpdated`, from `tabs.onUpdated`) and keeps
  `boundUrl` current, so "Reopen and continue" goes to the latest page.
- A closed tab is handled once per tab id, whichever report comes first (`tabs.onRemoved`, or `debugger.onDetach`
  with `target_closed`, which is ignored while the tab still exists).
- When a run's last tab closes and it is not mid-form or mid-send (`AgentContext.isMidForm`: a field typed into, an
  option chosen or a commit in the last 3 steps; or a commit waiting for the click), the tab is opened again on its
  last page, in its window (or the last focused one, in the background, when the window closed too). The run is
  paused while the page loads, so no step fails on the dead tab, and the next page state tells the model it is a
  fresh page. One reopening per run.
- Otherwise the run ends as `tab_closed`, as before; #66 queues that again.
- Stop is the only signal that ends a task: a stopped run gets no tab back. Neither does a tab the task closed
  itself (`close_tab`), a page the firewall or the agent's sites do not allow, or a tab whose own last page is not
  known.
- The mid-form marks start clean with every task (`AgentContext.startTask`): a kept executor runs follow-ups, and
  what an earlier task typed says nothing about the next. A note to the model stays until a step that saw it goes
  through.
- E2E: `threads.e2e.mjs` "closing the tab while the task is only reading reopens it…".

### Failed tasks retry, then report (2026-11-20, #66, docs/growth-team.md Part 2)

- Every run that ends with an error gets a class (`src/background/retry/classify.ts`, on `ThreadRecord.failure`):
  **temporary** (tab closed, background restarted, steps that kept failing, anything not understood), **needs the
  user** (model key, another extension on the tab, the debugging bar closed), **cannot** (blocked site, refused
  request, out of steps). The executor says what it knows through `Executor.failureCode`.
- Temporary: the job runner tries again after 1, 5 and 15 minutes (job `thread.retry`, `retry/endings.ts`). A try is
  `continueThread(…, { auto: true })`: the same task (`taskRunId`, so do-once keys hold), resumed from the transcript
  with the note of what was already done, its page reopened in its own window without taking the screen.
- After the last try, or at once for the other two classes: one Inbox item (`system|stuck:<task>`), and one WhatsApp
  line for a temporary failure. `report` checks the Inbox first, so there is never a second one.
- A step only the user can do (sign-in, CAPTCHA, code) is one Inbox item while the chat waits, per task and kind; an
  agent's own Inbox item now names the step.
- Agent runs use the same queue: while the chat is queued, the run stays open (`agents/service.ts`), so it is one run
  for `runsPerDay`; model spend still counts toward `dailyUsd`, and an agent over its cap waits for tomorrow. A run
  the agent stops itself (budget, time, off its sites) is `quiet`: the chat neither retries nor reports.
- Stop on a queued task, a new message, or the user's own Retry/Continue drops the queued try. A run left for more
  than an hour before the background came back is reported, not started by itself.
- A chat is only tried while somebody follows it. An agent's chat needs its run still open (`ownerFollows`); a run
  that ends first drops the chat's try (`AgentService.finish`). A routine's chat (origin `workflow`) is never tried
  or reported from here: the routine fails its step and reports itself.
- A try that cannot start (every slot busy) looks again every 30 s for 30 minutes as a job of its own, then gives up
  and says so; it never leans on the job runner's five attempts. The tab it opened is closed again when it cannot
  start.
- "Too many failures" keeps the last step error: it is the reason in the Inbox item, and a missing model or an
  account out of credit is classed as needing the user instead of being tried three times
  (`codeOfStepError`).
- The user's own Retry/Continue on a stuck task starts a new round (`retryRound`): the old Inbox item is settled, and
  getting stuck again is reported again.
- Known, not done: routines do not retry a browser step; time waited before a restart counts against an agent
  run's 20 minutes; a tab reopened for an agent sits outside its tab group.
- The unused `retryDelay` agent option is removed.
- E2E: `threads.e2e.mjs` "a task that fails for a passing reason is tried again by itself a minute later…".

### The morning brief tells the truth (2026-11-20, #67, docs/growth-team.md Part 5a)

- A source that is not connected, or could not be read, is named ("Calendar: not connected."), never shown as 0 or
  as a free day. Every source the brief reads is read on its own (`MorningBrief.build`), and the brief ends with the
  line of what it read and what it could not, so an empty brief can be trusted. The strings are in the locale files
  (`brief_source_*`, `brief_calendar_*`, `brief_line_*`).
- The calendar says how far it can be trusted: `CalendarWatcher.reading()` returns `read`, `not_connected` or
  `failed` with the events of the last read that worked (`asOf`). Events are kept in `upcomingEventsStore` with
  `okAt`, and a new watcher starts from them (`hydrate`), so a restarted background no longer empties the day or
  writes an empty day over the stored one after a failed read.
- "Waiting on you" counts each thing once (`waitingItems` in `brief/brief.ts`): chats paused on an approval or on a
  step only the user can do, agent and routine runs waiting for a click, Inbox items needing a decision, and failed
  tasks. A task queued to try again by itself (#66) is not counted.
- The WhatsApp line and the desktop notification name the first meeting by its time and the top waiting item by
  name (`briefLine`): "2 meetings, first at 10:00. 3 waiting on you: approve Suture post, and 2 more." A meeting's
  title is never in it. `brief_counts` is gone.
- After review: a routine waiting on a click is one thing, whether it waits in a chat of its own or on an agent's
  run (`waitingRuns` follows the chain); an all-day entry is not a meeting and has no time; "this is what it showed
  at …" names the day and is only said with events to show; the Mac's Calendar with no calendar ticked counts as
  not connected; an Inbox item whose chat was deleted and an archived chat are not counted.
- Not built here: the Team section (#78). From #32, still open: asking for the Mac's Calendar permission again while
  it is lost, and showing it on the setup checklist.

### Ava knows every open tab (2026-11-20, #68, docs/growth-team.md Part 3)

- `src/background/browser/tabRegistry.ts`: per tab its window, address, site, title, when it opened and when it was
  last in front, fed by the tab events and kept in `chrome.storage.session`. `list()` always asks Chrome which tabs
  exist now, so a missed event can make an age wrong but never lists a tab that is gone. Private windows, pop-up
  windows and the agents' own window are never listed. Which task holds a tab is asked from the thread manager when
  the list is read (`src/background/tabs/register.ts`).
- A new task that names a site the user already has open starts on that tab, in whichever window it is
  (`tabsToBind(windowId, hint)`, `tabs/reuse.ts`). The hint is plain code (`tabs/hint.ts`): a written address
  ("facebook.com"), or the site's name after a word that points at a place ("on Slack", "go to Facebook"). A task
  about the page in front ("summarise this page") names no site. The chat says "Using the facebook.com tab you
  already have open." and the tab comes to the front of its own window.
- `_adoptable` (`browser/context.ts`): a task a person gave (typed, said, sent from WhatsApp) may take a free tab from
  any ordinary window. **A decision beyond the spec:** an agent's or a routine's run keeps the old rule, the windows
  it already works in, so it never takes a tab the user has open (`TabBinding.anyWindow`).
- The state message lists the task's own window one by one, as before, and sums up the other windows by site:
  "facebook.com: 1 tab, open 3 h, last used 20 min ago", at most 30 lines, busy tabs marked (`tabs/section.ts`).
  `find_tab(query)` gives ids for `switch_tab`; titles come back wrapped as outside content.
- `groupTabs` groups only the tabs in the first tab's window: grouping a tab taken over elsewhere would move it.
- No new permission. Not built here: `history` as an optional permission and `search_history` (the second half of
  Part 3, to follow once reuse has been used for a while).
- Tests: `browser/__tests__/tabRegistry.test.ts`, `tabs/__tests__`, the "#68" block in
  `threads/__tests__/manager.test.ts`, and `e2e/tabs.e2e.mjs` (a second window, real tabs).

### Product profile per workspace, and the Suture workspace (2026-11-20, #69, docs/growth-team.md Part 6)

- `src/storage/lib/products`: `ProductProfile` (one per workspace, storage key `products`) and `productStore`.
  `cleanProductProfile` is the one shape that is kept: a half-filled part (a beta rule with no numbers, a north
  star with no target, a sender with no address) goes back to "not set" instead of being stored with a 0.
- Agents read it in the state message, right after the workspace section (`background/products/section.ts`,
  called from `workspaces/inject.ts`): "These are the only facts about this product you may state", then one line
  per fact, and "not set" for every gap.
- Edited in the workspace screen (`side-panel/workspaces/ProductFields.tsx`): a line under the heading names what
  is not set yet. Ava changes it with `update_product_profile`, which shows every changed field with what it says
  now and saves only after the user's click. That tool reaches the product's facts only: the budget, the beta
  rule, the sender, the postal address, the accounts and the admin console are set by the user in the screen.
- Seed (`products/seed.ts`): only when `VITE_SEED_PROFILE=avi`, once, and on an install that already had its
  workspaces. Suture's facts come from the owner's brief and from trysuture.com as it read on 2026-11-20. Not
  given yet, so empty: the outreach address, the postal address, the beta rule, the social accounts, the north
  star, where to tell the owner, and the admin login.
- **Differences from the spec's shape:** `slackChannels` holds a name and an id (the Slack connector reads by
  id); `postalAddress` is a field of its own; `northStar`, `budget`, `notify` can be null (not set).
- After review: number fields and the Slack rows keep what is typed (so "12.5" and a second row can be typed);
  the stage is "not set" until picked; "spent" is only stated once something was spent; every text is kept on one
  line, so a value cannot pass itself off as another line of the profile; Ava's change is applied to the profile
  as it is when the user confirms, and nothing is saved for a workspace deleted meanwhile.
- Known and left: the seed's text is in the public source and in every bundle (as the owner's other workspaces
  already are); it only runs in the owner's build. Two extension pages saving two workspaces' products in the
  same instant can lose one of the saves.
- Tests: `storage/lib/products/__tests__`, `background/products/__tests__`, `e2e/products.e2e.mjs`.

### Growth numbers: the store and the collectors (2026-11-20, #70, docs/growth-team.md Part 7)

- Database version 8 (`src/storage/lib/growth`): `growthMetrics` (a number that was read: product, UTC day,
  source, metric, value, and optionally channel, campaign, post), `growthReadings` (for one metric on one day:
  read, or not and why), `growthSources` (whether a source can be reached now, and the reason last told), and
  `growthLinks`. A day with no "ok" reading has no number: **it is "no reading", never 0.** A failed read never
  replaces a number that was read earlier; the answer says when it was read.
- The product collector (`background/growth/collect.ts`, `suture.ts`) reads the Suture agent API
  (`<admin console>/api/agent/v1`, bearer token) for yesterday and today, every two hours and on "Read now":
  sign-ups, waitlist, access requests and feedback (each with its sources and campaigns), spend, orgs, orgs
  active in 7 days, orgs on a paid plan. Every answer is checked against the documented shape; anything else is
  "no reading". Off (503 `agent_api_off`), a refused token (401), no token, or no answer make the source "not
  connected" with that reason, after one request. One failure makes one Inbox item; the next comes after it
  worked again or for another reason.
- The token is in the vault (`product-api:<workspaceId>`), pasted in the workspace screen under Numbers, which
  also shows the state and "Sign-ups today". It is never in source, storage.local, a log or a reply.
- `metrics_query(metric, from/to or days, by)` is the only way an agent reads numbers, for the product of its own
  workspace only. `make_link(url, source, medium, campaign)` tags a link to the product's own site and keeps it.
- **Where the live API differs from Part 13** (the API wins): no emails or names come back, only counts and
  sources; `/signups` can say it has no reading; `/payments` always does (Suture keeps no payment records), so
  `payments` is "no reading" and `paid_orgs` is read instead; `/spend` is cost to serve, not revenue.
- **Not built here, and why:** the page collector for the super admin (the API is live, and its rule, "check it
  is the page you expect or record no reading", is applied to the API's answers instead); the social and email
  collectors (their sources arrive with #76 and #79); Slack counts (they come with the product pulse, #71); link
  clicks (nothing counts a click yet: a link's effect is read as sign-ups by campaign).
- A new call outside the model provider: the product's own API, at the address in its profile, https only (plain
  http on this computer for tests), with no cookies.
- After review: a number that says how things stand (`orgs`, `active_orgs`, `paid_orgs`) is never added up over
  days, the answer gives the latest; a day read before it was over is marked "not final" and is read again later,
  as is a day that could not be read (up to two older days a run, within a week); a list cut at the row limit
  never replaces a whole one; only the API's own `agent_api_off` counts as off; a notice is marked as told only
  once the Inbox has it; the token is kept under the host it was saved for (`product-api:<workspace>@<host>`), so
  changing the address never sends it elsewhere; `paid_orgs` is the product's own count; the collect job is
  scheduled once, not on every start of the background.
- Tests: `background/growth/__tests__`, `e2e/growth.e2e.mjs` with `e2e/mock-suture.mjs`.

### Rounds and check-ins (2026-11-20, #71, docs/growth-team.md Part 4)

- `src/background/rounds`: a job ticks every five minutes and does at most one thing, the one round that is due
  or else one offer. Times are local: product pulse 08:30 and 16:00, mail 09:00 and 14:00, stuck work 12:00
  (`plan.ts`, pure and tested with a fake clock). A slot is marked before its round runs. A round missed while
  the browser was closed runs once when it opens that day: only its latest slot, the earlier ones are marked
  missed. State is in `storage.local` (`rounds`), a new day starts clean.
- Product pulse (plain code): collects each product's numbers, then per metric "today so far, yesterday, usually".
  "What changed" is arithmetic (`whatChanged`): at least 50% and at least 5. **A choice beyond the spec:** a whole
  day (yesterday) is compared with the seven before it and flagged up or down; today so far is flagged only when
  it is already up, because a day that is not over always looks down. Slack notifications are counted by the
  kind in square brackets, through the Slack connector's read tool when the user set it to run without asking;
  otherwise the pulse says why they were not read. Counts are kept as `slack_<kind>` numbers.
- Stuck work (plain code): the brief's own `waitingItems`, so the two never disagree.
- Mail: asks the Mail agent (`team_mail`) for a run in the agents' own window, unattended, one per slot; its answer
  in the Inbox is the digest. With no Mail agent the round says so once a day.
- Each round is one Inbox item. A flagged change also goes to WhatsApp when the product's notify channel says so;
  never to Slack, which would be a post.
- Check-ins: after three quiet hours between 09:00 and 18:00 (from the user's last task, the browser opening, or
  the last offer), not in a meeting, at most two a day: one Inbox approval built from what the rounds found
  ("Want me to sort your mail? 14 unread.", or failed tasks to try again). Approve starts it with the user
  there; decline is "not today" and silences offers until tomorrow. Offers left unanswered are closed when the
  day turns. With nothing useful to offer, none is made.
- Settings › General › Rounds and check-ins: the switch, each round's times and what ran, "Run now".
- **Not built here:** reading Slack in the browser tab when no connector is on (it needs an agent run with a
  skill, not plain code); the Slack count has not been run against the live Slack connector, only against a
  stand-in with the documented tool shape.
- After review: an offer is taken once (two clicks start the work once) and is closed in the Inbox when answered
  or when the day turns; a retry offer only touches chats that still stand failed; an offer never counts as
  "waiting on you" in the brief; a round that fails or was cut off by the background stopping says so in the
  Inbox, once; "quiet" is the newest change to a chat the user started, not its creation; a yesterday read before
  it ended is not flagged; Slack kinds count only at the start of a message, the eight most frequent; Settings
  only looks at the state and never turns the day over.
- Known and left: rounds are on by default; the pulse's days are UTC days (said in the digest); a Slack kind that
  stops appearing is not flagged as a drop; only today's Slack messages are read.
- Tests: `background/rounds/__tests__` (clock rules, arithmetic, the tick, offers, a simulated full day),
  `e2e/rounds.e2e.mjs`.

### Approval modes, the budget ledger and tool requests (2026-11-21, #72, docs/growth-team.md Part 9)

- Store: `src/storage/lib/growth-team` (Dexie v9: `teamItems`, `teamLedger`). Code: `src/background/growth-team`
  (`modes.ts`, `ledger.ts`, `privacy.ts`, `queue.ts`, `requests.ts`, `actions.ts`, `register.ts`).
- Three agent actions: `queue_for_approval`, `request_spend` (amount, what it buys, tried for free, expected),
  `request_tool` (the free-first ladder: connected, free API, browser, free tier, paid; paid becomes a spending
  request, a free tier a new-account request).
- Modes: posts, replies, outreach, follow-ups and listings go in one batch per agent per day, approved with one
  tap ("Approve all 3 drafts from …"). An issue from a customer and a beta grant can be "Allow every time", kept as
  a `team` rule in PR #92's `permissionRulesStore` (scope `team:<workspace>/<agent>/<action>`), and then run by
  themselves. Spending, a new channel, a new account, a plan change, a tool, and anything that names a customer
  always ask: `canAllowAlways` refuses those rules, and a forged one is ignored.
- Limits in code: the beta rule (testers a week over a rolling 7 days, the plan, the days; the product's own
  `grants.remaining` wins when it can be read), the marketing budget, 20 items per agent per day, 10 customer
  issues a day. The check and the write of a ledger line are one transaction, so concurrent yeses cannot pass the
  limit. An item is written down before anything happens and is carried out once.
- Nothing goes out in this phase: an approved post or email is "held" until #43 lands an executor.
- After review: a customer's email, phone, name or id link in a post, reply, issue or email is refused, not only
  flagged; a grant agreed here and not yet given in the product counts against the product's own places; a tap on
  the batch row approves only the drafts it showed (its answer carries a fingerprint of them); a spend or grant
  agreed just before the background stopped is written to the ledger on the next start; a yes that a limit
  stopped is said in the Inbox. Known and left: the daily item caps are counted outside a transaction, so two
  proposals landing together can pass them by one.
- The workspace screen shows the ledger: spent of budget, beta places this week, waiting and held.
- Tests: `background/growth-team/__tests__` (rules, queue), `e2e/team-approvals.e2e.mjs`.

### Three personalities for the growth team (2026-11-21, #73, docs/growth-team.md Part 8)

- Built-ins `growth` (inspired by Sean Ellis), `positioning` (April Dunford, with the channel tests from
  *Traction*) and `build_in_public` (Arvid Kahl) in `src/storage/lib/personalities/builtins.ts`. Each one's
  instructions hold, in order, five beliefs, "When …" rules, first questions and what to avoid, in our own words,
  under 2,000 characters. Sources: `docs/personas/<id>.md`.
- Inspired by, never the person: the instructions say so, and code makes it hold. `PERSONA_SOURCE_NAMES` lists
  the people and their books; `growth-team/persona.ts` refuses a post, reply, email, listing or issue that names
  one (or speaks as one) before it reaches the Inbox. The operator's Bezos is on the list too.
- The local voice engines have seven voices besides Ava's, so two of the nine built-ins share one there; the test
  now says every voice is used before one is shared.
- Eval kind `draft` (`evals/runner/draft.ts`): four cases, three refused drafts and one clean one.

### The Growth Lead (2026-11-21, #74, docs/growth-team.md Part 8)

- Template `growth_lead` in a new "Growth team" group of the team setup, off until turned on, `executor:
  'browser'`, personality `growth`. It needs a workspace with a product (`growth-team/setup.ts`); with a Claude key
  it gets Sonnet 5.5 for `smart` and Haiku 5.5 for `fast`, without one the Inbox says once that it uses the user's
  own roles. The Monday plan's Opus comes with #77.
- Feedback: `read_feedback` reads the product's `GET /feedback` for yesterday and today, drops what was sorted
  (Dexie v10 `teamFeedback`), and fences the customers' text as data. `sort_feedback` takes the model's sort and
  the facts of what broke; code does the rest (`lead/feedback.ts`): the priority from the rule (`lead/priority.ts`),
  one `customer_issue` per feedback through the approval queue, labelled `from-customer` with the super admin link,
  feature requests counted by topic until the third ask opens one issue, praise put on the bus as `growth.praise`
  with no name. A summary that holds an email or phone is refused, and a refused issue unsorts the feedback.
- `request_beta_grant` proposes a `beta_grant` on the product's rule; the limits are #72's code.
- Signals: a 07:40 job (`growth-signals`) puts `growth.signal` on the bus for each channel whose sign-ups moved
  yesterday against the 7 days before (`lead/signals.ts`), only on days that were read.
- Not in this phase: filing the approved issue on GitHub, granting the beta place, and the Slack line for each
  filed issue. Approved items stay held with their text ready until an executor lands (after #43).
- Eval kind `lead` (`evals/runner/lead.ts`): recorded tool calls through this code, five cases (priority by rule,
  duplicates, customer details blocked, a grant past the rule, a grant inside it).
- After review: the signals job is scheduled once (a restart no longer pushes a due run to tomorrow); a proposal
  or a praise hand-off that throws unsorts the feedback; every angle bracket in a customer's text is escaped and
  the tag's attributes keep plain characters only; one malformed feedback row is left out instead of the day; a
  team setup with a growth agent checks the product before making any draft. Left as they are, and why: a
  sort of an id the model was never shown is not refused (a read id can be mis-sorted just the same; the user
  approves every issue); a P0 that arrives after the day's 10 issues waits for tomorrow; feedback older than
  yesterday is not read again; the 07:40 job reads the UTC day before.
- E2E `e2e/growth-lead.e2e.mjs`: the Growth team group, the product check, and a sort that ends as "[P0] …"
  waiting in the Inbox while a customer's email is sent back.

### The Product Marketing Manager (2026-11-21, #75, docs/growth-team.md Parts 8 and 12)

- Template `growth_marketing` in the Growth team group, personality `positioning`, `executor: 'browser'`,
  weekdays at 10:00 and on `growth.signal`. Positioning goes through `update_product_profile`, which shows the
  change first; the instructions say positioning comes before channels.
- Channels (`marketing/channels.ts`, Dexie v11 `teamChannels`): `add_channel` keeps ideas with who is there and
  a test's cost; `rank_channels` ranks by sign-ups a week over the last 28 read days, then the untested cheapest
  first, and marks three "test next". `propose_channel_test` asks only for those (a `new_channel` request, always
  asked); the user's yes starts the 7-day week through `registerAgreedHook` in the queue, which changes only
  Ava's own list. After the week code keeps or drops it by the rounds' test against the week before; a day not
  read leaves it testing.
- Outreach (`marketing/outreach.ts`, Dexie v11 `teamContacts` and the shared `teamSuppressed`): drafts only.
  Code refuses a suppressed address or a personal mailbox, a person already written to, more than 20 new people a
  day per product, and a follow-up before 3 whole working days or after the first one. Every draft ends with the
  sender, the postal address, why this person and how to opt out; a missing sender or address reads "not set" and
  the agent is told to say so. `stop_contact` puts an address on the list for every product.
- Eval kind `lead` is now `team` in `evals/runner/team.ts` (kinds `lead` and `marketing`): four new cases
  (suppressed address, the daily limit, one follow-up, ranking from numbers).
- E2E in `e2e/growth-lead.e2e.mjs`: the draft waits in the Inbox with "sender: not set", and the unsubscribed
  address is refused.
- Not yet: sending (Nex Mail, Part 12, after #43), and finding people (the agent browses public pages itself).
- After review: the address rules live in `propose` itself (`growth-team/addresses.ts`), so no tool goes around
  them, and `queue_for_approval` no longer takes emails; addresses are kept in one form (lower case, no "+tag");
  personal mailboxes are matched by name whatever the country ending; the footer is added after the checks, so a
  postal code is not taken for a phone number; a follow-up counts from the user's yes to the first email and
  never follows a declined one; a person takes the day's place in one transaction; an address stopped while its
  email waited is not carried out; a declined channel test may be asked for again; `startTest` keeps the three-at-
  once cap in a transaction; a test unread two weeks after its week is dropped; "no reading" is never shown as 0.
  The send executor (after #43) must check the do-not-write list again right before sending. Also: the queue
  takes extra draft checks (`registerProposalCheck`), used by #76.

### The Product Social Manager (2026-11-21, #76, docs/growth-team.md Part 8)

- Template `growth_social` in the Growth team group, personality `build_in_public`, `executor: 'browser'` on
  x.com and linkedin.com with the account-switching skill, weekdays at 11:00 and on `growth.signal` and
  `growth.praise`. It is built on `team_social`, which stays as it is.
- Facts (`social/facts.ts`): every agent's post, reply, listing or email goes through a draft check registered in
  the queue. Code refuses a number that neither the product profile nor the metrics store holds (sums over 7, 28
  and 35 days ending today or yesterday, read days only; a day with no reading counts for nothing), and any
  quote of four words or more. Links, handles, times, years and counts up to 10 pass. The user's own chat is
  never checked.
- `post_results` (`social/posts.ts`) sums what each post brought over 14 read days; with none it says "no
  reading".
- Evals: three `social` cases (an invented number, a customer quote, the product's voice and the approval step).
- E2E: the Product Social Manager is in the Growth team group and starts with its own personality.
- Not yet: posting (after #43). The product's social accounts are "not set" in the profile until someone sets
  them, and the agent says so instead of posting from another account.
- After review: "12k", "1.5m", "100x" and "1.200" are read as the numbers they say (a rounded "12k" matches a
  known 12,345); every window metrics_query can total (up to 92 days ending today or yesterday), whole months,
  and the change on the week or four weeks before (matched only by a number written with "%") are known, as is
  any number metrics_query or rank_channels showed in the last day; single, curly and corner quotation marks and
  Markdown quote lines count as quotes, apostrophes do not; a routine's or agent-started chat is checked even
  with no agent id, and the draft's fields are checked with its text.

### Weekly plan and daily standup (2026-11-21, #77, docs/growth-team.md Part 10)

- `src/background/growth-team/standup`: `plan.ts` (the clock, the word limits, the off-plan check; no model),
  `run.ts` (the plan and the standup, with the model calls behind a `StandupWriter`), `writer.ts` (the real
  calls). State: `standupStore` (`storage.local`, `src/storage/lib/standup`), last three weeks kept.
- Monday 07:30 (job `growth-plan`, caught up through the week): the Growth Lead sets one focus and at most three
  experiments (E1-E3, an owner off the team becomes the Lead) on Opus when a Claude key is set, then each agent
  writes its week against them. A week that has no plan gets one before its first standup.
- Every day 07:45 (job `growth-standup`): code reads yesterday and the last 7 days (a number never read is listed
  once as "no reading"); each switched-on growth agent writes a note, cut by code to 80 words; a "today" item that
  names no experiment is marked off plan with the agent's reason; the Lead's summary is cut to 200 words, and
  with more than one off-plan item code adds "Off plan (n): <agent>: <item> (<reason>)". A number in the summary
  no reading holds is flagged. Four model calls a day. The result goes to the Inbox ("Growth standup · <product>
  · <day>") and to `growth.standup` on the bus.
- A missed standup runs once if the browser opens before noon (also checked at startup); after noon it is skipped
  and says "Standup did not run: the browser was not open between 07:45 and 12:00". Over the spending cap it
  fails with that reason.
- The Growth Lead's page has "Run today's standup" (`gteam_standup_run`), still once a day.
- Tests: `standup.test.ts` (three mornings on a fake clock, the off-plan items named, late and skipped mornings);
  evals: `standup` kind, two cases; E2E: the three agents switched on, the standup run, opened in the Inbox.
- After review: a start older than 15 minutes (the browser closed mid-run) is taken over, so a lost run never
  holds the day; the button runs a skipped or failed day again; at most three "today" items per note, reasons
  cut, the off-plan line lists five by name and the rest as "and n more", and the whole summary, flagged numbers
  included, stays within 200 words; on Monday before 07:30 a click writes this week's plan; a team switched on
  after the standup's hours gets no "did not run" item; the plan in prompts is quoted as data; a failed standup
  shows a model error by its kind only. "Yesterday" is the last whole UTC day, as the product's numbers are kept.

### The Team section of the morning brief (2026-11-21, #78, docs/growth-team.md Part 5b)

- `src/background/brief/extras.ts`: other features add brief sections through `registerBriefExtra` (`pending`,
  `sections`); the brief waits while one is pending and shows each section under its bold title.
- `src/background/growth-team/standup/brief.ts` registers "Team · <product>" for each workspace whose Growth Lead
  is on: the Lead's standup summary (at most 200 words), or "Standup did not run: <reason>" (it starts at 07:45,
  after this brief; still running, added when it ends; the browser was not open at 07:45, it runs now; the
  browser was not open between 07:45 and 12:00; or the recorded reason). The brief waits for a running standup
  until 07:58, or 13 minutes after a late one started.
- A standup that ends after the brief adds its section to the brief's chat (`addSection`) and lets a waiting brief
  come (`check`).
- Tests: `team-brief.test.ts` (every wording, the waiting rule, a ran day and a skipped day on a fake clock) and
  `brief/__tests__/manager.test.ts` (the brief waits, then shows the section); E2E: the brief made after the
  standup shows the Team section with the off-plan line.
- After review: a section that ends while a brief is being made is added once that brief is saved, not dropped; a
  standup that ends before the background has started leaves its record for the brief to read; an empty summary
  says the standup ran and the notes are in the Inbox. Not changed: a standup re-run by hand after the brief adds a
  second Team section to the chat, under the first.

### The task board (2026-11-21, #104, docs/pm-desk.md Part 2)

- One `tasks` table (Dexie v12) and `taskStore` in `src/storage/lib/tasks`: add, update, setStatus, setOwner, list,
  get, merge, move, record, closeOlderThan, onChange. `recordTask` is the only way in for meeting action items, graph
  `action` readings and the agent's `task_add`; it applies the 2.2 rules in code (same workspace, same or no owner,
  within 14 days, titles equal or 85% word overlap, the same numbers) and fills gaps without reopening.
- A one-time backfill of the last 30 days of meetings and graph readings (`src/background/tasks/backfill.ts`).
- Live checkboxes: a task line is `- [ ] words ^tsk_xxxxxxxxxx`. A box is live only when the message's own `taskIds`
  name the id and the task exists; anything else, including a marker a model wrote, is plain text. Markers are
  stripped from WhatsApp, voice, copy, export, memory and the knowledge base.
- The brief shows one list per workspace (top 5 open tasks, then "…and N more"); workspace summaries no longer
  write "Next actions" and show the board's open tasks instead.
- The Tasks page (drawer, after Inbox): by workspace or by person; open, done, dropped; add, edit, give, move, merge,
  drop; "Close everything older than two weeks" drops them (reopenable).
- Tools `task_add`, `task_done`, `task_reopen`, `task_list`, `task_assign`, `task_move` for the agent (acts as Ava,
  in its chat's workspace, never moves a task Avi placed) and for voice (acts as Avi, every workspace). When several
  tasks fit the words, the answer lists them with ids and the model asks which.
- Tests: `src/storage/lib/tasks/__tests__`, `src/background/tasks/__tests__`, `src/side-panel/tasks/__tests__`,
  brief, meetings, summaries; E2E `e2e/tasks.e2e.mjs`.

### People: who is who, under every name (2026-11-21, #107, docs/pm-desk.md Part 5)

- Store: `src/storage/lib/people` (Dexie v14 `people`, `peopleNames`). `observe` is the one way in, plain code: a
  known email, phone or handle is that person whatever the name; a bare name seen once is only watched; it is asked
  about after a second sighting, at once when a task waits on it, and at once for names on a call. `resolve` goes
  exact name in the workspace, alias for the workspace, alias for everywhere, unique first name. An alias saved for
  one workspace never resolves in another.
- Safety rules in code: a name match never adds an email, phone or handle (it becomes a "Yes, <name>?" question);
  a first-name match adds nothing; an identifier only suggests on an open question; a roster/invite name pair links
  an address only when the name is unique on both and the person has none yet.
- Sources: Meet roster (tiles always, the People panel only while open, never a click) and caption speakers given
  to audio segments by time overlap (`meetings/speakers.ts`); names in a finished note's action items; calendar
  `ATTENDEE`/`ORGANIZER` (`calendar/ics.ts`); Gmail senders with their address; Slack direct messages with their id;
  WhatsApp chats read or drafted into; GitHub connector results (authors, assignees, reviewers); the knowledge
  graph's person readings of chats and notes. Not yet: the owner's own WhatsApp messages ("Ada says…") need names
  read out of free text; the Mac calendar has no attendees (#32).
- "Who's who" (`background/people/cards.ts`): a card after each call and one Inbox card a day at 17:30, at most six
  questions, each saying where the name was seen. Answers: yes to the offered match, the other name on the card,
  someone else, a new person, not a person. Every answer is kept for that workspace.
- People page (`side-panel/people`): people with their names per workspace, edit, merge, remove, and "To sort".
  `person_note` is a voice tool and an agent action; from a chat it takes only names the owner typed.
- Task board and vocabulary (`background/people/links.ts`): action-item and graph-action owners go through
  `observe` with source `task` and their task id; a resolved owner is linked with `taskStore.setOwner`, an unknown
  one is asked about and linked on the answer; a merge moves the tasks, a removal unlinks them (`replaceOwner`).
  Owners the task tools name (`task_add`, `task_assign`) are observed from the board's changes. Every person's name
  and the other names that hold in each workspace are vocabulary seeds (`addPersonSeeds`), synced after changes.
- Tests: store, sources, cards, note, meet and calendar unit tests; E2E `people-pages.e2e.mjs` (Meet, Gmail and
  Slack readers on saved pages) and `people.e2e.mjs` (answer a card in the Inbox, see the name on the People page).

### Screen recordings for a task (2026-11-22, #109, docs/pm-desk.md Part 7)

- Panel (`side-panel/recordings`): "Record screen" on an open task's row and in its menu. `getDisplayMedia` is the
  first call in the click (tabs first, `selfBrowserSurface: 'exclude'`); without a user activation nothing starts.
  A window or a whole screen asks "Record anyway" first. Mic is added when allowed; tab sound when a tab is picked.
  The bar shows a red mark, a timer and Stop. It also stops when the call ends, after 2 minutes of silence, at the
  limit (Settings → Meetings, default 10 minutes), or when the shared tab closes.
- Storage: chunks of one second go to a separate IndexedDB, `ava-recordings` (`storage/lib/recordings`), which
  backups never read (they snapshot only the main database). The panel writes chunks; the background owns every
  other write. A port (`screen-recording`) tells the background the panel closed: the recording stops there and
  what was captured is saved. Recovery closes a recording with no chunk for 30 s.
- Saving (`background/recordings`, job `recording_save`): Google Drive when the `google_drive` connector is
  connected with the `drive.file` scope, to "Ava recordings / <workspace> / <date> <title>.webm", resumable in 8 MiB
  pieces with the session URL saved so a retry continues the same file. The file starts private. Otherwise Ava
  Brain saves it to `~/Movies/Ava recordings/<workspace>/`, otherwise the panel downloads it, and one Inbox item
  offers to connect Drive. Do-once keys guard the upload and each share.
- Share (`share.ts`): only the Share click makes the file "anyone with the link can comment" and adds the link to
  the task; Stop sharing removes the permission and the link. `shareRecordingsFor(taskIds)` for other features.
- Limits: MediaRecorder WebM has no duration index, so some players cannot seek until it has played through. No
  manifest permission was added.
- Tests: Drive client against a fake that drops connections, save and share, backup exclusion, store, recorder,
  Brain routes; E2E `recording.e2e.mjs` records a tab with the mic while meeting notes run (file checked with
  ffprobe), and uploads to a fake Drive through CDP on the service worker, with one dropped piece.

### Tasks said on a call (2026-11-22, #108, docs/pm-desk.md Part 6)

- Hearing (`src/background/call-tasks/match.ts`, plain code, no model): "(hey) Ava, (please) note/add/log/create (a)
  task for <name>: <words>", with the recognisers' spellings of "Ava" from `offscreen/stt/addressed.ts`. The name and
  words go through the vocabulary; the owner comes from `people.resolve`, an unknown name is kept as said and goes to
  Who's who (`people.observe`, source `spoken`).
- Whose voice (`signal.ts`), never decided by a name:
  - notes from captions: only lines the page marks as the user's own (`CALL_DOM.selfLineSelectors`,
    `[data-self-name]`) and labels "You". A "You" line without the mark (before any marked line), or the mark on a
    line with another name, turns commands off for the call, and the panel says so. Not yet seen on a live Meet.
  - notes from the tab's audio with the mic: a separate echo-cancelled mic stream (`src/offscreen/call-mic.ts`) and the
    local recogniser; a match is refused when the same words were in another speaker's caption within 3 s.
  - neither: commands off, and the status line says why.
- Timing and drafting (`engine.ts`): a caption line counts once it stood unchanged for 1.5 s; the task is stored by
  `recordTask` at once; it stays open two minutes for "also / and / add to that / Ava, …" lines, and closes four
  seconds after any other sentence or at the next command. Meet's rewrites of a line change the same task.
- State: `MeetingRecord.callTasks` (`CallTasksState`, no Dexie step). Panel: `CallTaskCards` during the call (Edit,
  Discard, "Record the screen for this?"), and the turn addon "Tasks from this call" after it.
- After the call (`after.ts`): nothing is sent or shared before "Looks right". The click shares the recordings
  (`shareRecordingsFor`), sends one WhatsApp message per person to the user (one message for more than five; quiet
  hours hold), and offers "Draft a message to Ada", which types into Ada's WhatsApp Web chat and never sends.
- Seams for #111: `addCallListRows(meetingId, rows)`, `onCallListRowAction(kind, handler)` and
  `onCallTasksConfirmed(listener)` in `call-tasks/register.ts`.
- Tests: replayed caption and mic fixtures (another speaker, a guest named "You", a guest named "Avi", a line
  rewritten three times, follow-ons, two commands); E2E `call-tasks.e2e.mjs` on a fake Meet page.

### Follow-ups: who is doing what, and who to chase (2026-11-22, #111, docs/pm-desk.md Part 9)

- Person updates (`background/followups/note.ts`, `updates.ts`): the meeting note gains `personUpdates` (did, doing,
  next, by, blockers) and a "## Updates" section. Code keeps one per person in the Dexie table `personUpdates` (v16):
  not Avi, not "the team", and, when captions name the speakers, only someone who spoke. Names go through
  `people.resolve`, else `people.observe` (the call's Who's who card). The id is fixed per call and name, so a rerun
  keeps one record and Avi's answers.
- "Mark done?": a "did" that clearly matches one open task of that person (`match.ts`: three quarters of the title's
  words, the opening verb left out, no line that says "not") is only offered, as a card
  under the call's note in its chat (`side-panel/followups/MarkDoneOffers.tsx`, until #108's after-call list takes
  it). Only the Yes click closes the task, as Avi's.
- Status (`status.ts`): latest update plus open tasks, on the person's row and page, as `person_status` (voice and
  agent), and Avi can type what someone said on their page.
- Who to chase (`rules.ts`, `today.ts`, plain code): tasks someone other than Avi owns (`owner.ts`: "me", "Me.",
  "(You)", his profile name, its first word and "Avi E.", a person record with his name or a workspace's Google
  address). Nobody is chased until his profile has a name; the brief says to set it. Due when the due date has passed; with no due date,
  after 3 working days with nothing heard (task made, mentioned on a call, or an update); or when `followUp.nextAt`
  comes. Weekends are skipped, except the day after a weekend due date (that weekend only). Five a day at most, most overdue first; the
  day's pick is kept (`followup-day` in `storage.local`) and never refilled.
- Surfaces: "Follow up today" in the brief (`^fu_<taskId>` lines drawn as cards), WhatsApp `who's next`, and one
  Inbox item a day (job `followups_daily`, 08:30).
- The card (`FollowUpCard.tsx`): a draft from fixed facts (name, task, where it came from, due date) worded by the
  light model (`draft`), checked (names the person, no links, short), else a template; cached per facts. Copy;
  Draft in WhatsApp (only for a task linked to a person; opens their chat in Avi's WhatsApp Web tab, checks the
  header, refuses if the box already has his text, types, never sends);
  Asked (next follow-up two working days on); Done (closes it as Avi's); Snooze 1, 3 or 7 days.
- Reporting back: "<name> says …" on WhatsApp (matched in `task-commands.ts`) or typed on the person's page is a
  `PersonUpdate` (the agent and voice tools keep one only when the name and most of the words are the user's own);
  the light model reads the words, a named day becomes `by`, and the person's named tasks move their
  next follow-up to the first working day after it (or 3 working days on). A "did" is offered, never closed.
- Tests: rules on a fake clock (weekend, month end, snooze, Asked, a Saturday due date, five of eight), today, buttons,
  match, updates, report, owner, store, the `says` command; eval `note_updates` (two people, only talked about,
  nobody); E2E `followups.e2e.mjs` runs a captions call with two speakers and moves the background clock to a
  Tuesday for the brief card, Asked and Done.

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
