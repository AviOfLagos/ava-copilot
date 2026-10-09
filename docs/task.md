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
