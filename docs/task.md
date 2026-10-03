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

### M3 — Meeting notes (L)

- [ ] Offscreen document, `tabCapture` started from the button click, audio routed back to the speakers
- [ ] Optional mic, mixed in with WebAudio
- [ ] Chunker (30 s, 2 s overlap) with a queue persisted to IndexedDB, so a network drop never loses audio
- [ ] Transcriber built on the existing speech-to-text service
- [ ] Rolling summary every 2–3 min, hierarchical past 2 h, structured final note
- [ ] Caption-scraping fallback for Meet and Zoom Web
- [ ] First-run consent modal, recording badge, silence warning, storage quota warning
- [ ] Export: Markdown and clipboard

**Exit:** U3, U4 pass. A 1-hour call produces notes within 60 s of Stop.

### M4 — Knowledge base (M)

- [ ] Chunk and embed chats, meetings and saved pages (Gemini embeddings)
- [ ] Vectors in IndexedDB with brute-force cosine, plus MiniSearch for keywords
- [ ] Cited answers: meeting + timestamp, thread + message, page URL
- [ ] Retention, delete one, wipe all, export and import JSON

**Exit:** U5, U8 pass.

### M5 — Skills (M)

- [ ] Frontmatter parser, registry, URL and keyword matching, `/skillname`
- [ ] Three shipped examples, import and export
- [ ] Teach mode: "Save as skill?" after a successful task

**Exit:** `zedu-operator.md` imports and loads on Zedu with no core change.

---

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
