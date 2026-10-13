# Nex Copilot — Wave 2 plan: agents, workflows, integrations, inbox, voice, new shell

## Context

Nex Copilot is a strong single-agent browser copilot today: chat agent behind a confirm gate, threads, meetings,
voice + "Hey Ava", knowledge base + graph, workspaces, Obsidian, morning brief. Avi wants an operating layer on top:
many agents working for him, routines that run on their own and show how they are wired, tools plugged in from
anywhere (MCP, CLIs), an inbox where agents leave what needs him, answers he can hear, cheap or free voice, and a shell
that is easy to find his way around. Models are never hard-coded: whatever is available (local Ollama / LM Studio,
OpenRouter, NVIDIA, the big providers) is discovered and used.

**Asked for (all in scope):**
1. **Voice out:** answers read aloud by default when wanted, a speak button on every answer, a **Retry** button.
   The copilot may **speak up on its own** when something needs Avi; "**end the conversation**" by voice.
   **Free/local speech options:** KittenTTS, other free speech-to-text and text-to-speech, chosen in settings.
2. **Workflows / routines / schedules** (Claude Code-style), created by the main agent from plain words and shown as
   an n8n-style diagram that feedback can edit. Example: every morning check Hacker News and Hugging Face for the
   latest and feed the morning brief.
3. **Integrations:** MCP servers, skills per task, CLIs; connectors that feed an **Inbox** (Slack, mail, WhatsApp…).
4. **Sub-agents** with their own instructions, skills, tools/MCPs/CLIs, model, sandbox, triggers (a schedule, a watched
   tab) that feed each other; an **agent log**; agents have their own tabs.
5. **Artifacts:** agents build a landing page / design / animation and show it. Anything the extension cannot host
   (its security rules forbid it) opens in a **new tab served locally** by the Mac companion, like a dev server.
6. **Shell:** profile menu at the bottom of the drawer (Knowledge base, Workspaces, Connectors, Skills, Models & usage,
   Settings); top of the drawer: Home, Inbox, Today, Meetings, Workflows, Agents. The chat-row "⋯" menu floats above
   the list on a blurred, solid background. **Default workspace** (Nexprove), set in settings. Models, usage and API
   keys visible and editable in the panel.
7. **Interactive, animated, Obsidian-style graph**; knowledge filterable by agent; usage tracked per agent.
8. Non-negotiables: state management, error handling, retry with exponential back-off, credential and platform
   security, plus the existing rules (gate, untrusted content, workspaces never mix, nothing sent / posted / committed
   without a click).

**Interpretations (say if wrong):** "ACA news / arguing face" = Hacker News / Hugging Face; "what anything has" = n8n;
"the argue face view" = an Obsidian-style interactive graph view.

## Already done today (commit `3ba19c2`)

- **API key no longer logged:** `llmProviders.ts` printed the whole provider config, key included, on every save.
- **The mic no longer bills in silence:** a speech gate (`src/offscreen/vad.ts`) sends microphone audio to Gemini Live
  only while someone speaks (300 ms lead-in, 900 ms hold, noise floor that follows the room) and tells the model when
  speech stops (`audioStreamEnd`). Before, every second of an open conversation was sent and billed.
- **Closing the voice screen keeps it closed:** a start still under way when Avi ends it now undoes itself
  (`VoiceManager` generation counter), a stopped session reports nothing more, and the panel ignores late status for
  4 s after an end. New E2E: end while connecting → stays closed.

## What the surveys found that shapes this plan

- **Security:** keys are plaintext in `chrome.storage.local` (`'llm-api-keys'`), which content scripts can read by
  default; the Gemini key rides in the Live WebSocket URL (`offscreen/live.ts`, `offscreen/voice.ts`).
- **Hard-coded models:** `llmProviderModelNames` in `src/storage/lib/settings/types.ts`; only
  `options/geminiKey.ts` lists models. NVIDIA NIM / LM Studio already work as `custom_openai` (base URL), so the
  registry adds discovery and presets, not new SDK code; `createChatModel` (`src/background/llm/providers.ts`) stays.
- **Cost is only known for Gemini** (`usage/pricing.ts`), so the daily cap is blind to other providers. Usage is one
  `storage.local` blob per day and session (60 days / 200 sessions), not per model, agent or workflow.
- **Retry exists in three layers already:** the AI SDK (`maxRetries: 2` in `generate.ts`), the usage meter
  (`retryDelay` in `src/background/usage/meter.ts`: 429/5xx, 2s·2ⁿ, cap 60 s) and the executor (`maxFailures`).
  Meetings retry with a `setTimeout` that dies with the worker.
- **No scheduler:** four ad-hoc alarms; `alarms.create` re-arms on every worker start; the brief's first check is a
  `setTimeout` that dies with the worker.
- **No MCP code.** The MCP SDK must use `CfWorkerJsonSchemaValidator` (ajv uses `new Function`, forbidden by the
  extension's CSP). React Flow, react-force-graph-2d and croner are eval-free.
- **Panel:** the "⋯" menu is a near-transparent `.glass` box nested in the drawer's own `backdrop-blur-xl`, inside the
  scrolling list, closing only on mouse-leave → see-through and clipped. No `ErrorBoundary` (one exists in
  `src/shared/lib/hoc/withErrorBoundary`). Panel promise maps (`kbRequest`) have no timeouts.
- **Retry:** nothing re-runs a finished or failed task; `ThreadBar.tsx:142` hides Continue for `failed`.
  `continueThread` and `threadStore.fork(threadId, seq)` are the building blocks.
- **Voice out:** no TTS anywhere; `chrome.tts` (system voices, `tts` permission) speaks straight from the background.
- **No default workspace** (`seeded` is already true on Avi's install, so a default needs its own migration flag).
- **Graph:** custom O(n²) layout run to rest in `useMemo`, canvas click only.
- **Extension ID is not pinned:** an unpacked extension's ID comes from its folder path, so every worktree build gets
  another ID (breaks OAuth redirects and the companion's origin check). Avi just reinstalled, so pinning the key now
  costs only the settings re-entered since.
- **Shared hot files:** `background/index.ts`, `SidePanel.tsx`, `agent/actions/{builder,schemas}.ts`, the navigator
  prompt, `gate/review.ts`, `threads/manager.ts`, the three 2 700-line `messages.json`, `package.json`, `db.ts`.

## Architecture

```
            ┌──────────────────────── Brave ─────────────────────────┐
 you ──────▶│ Side panel (React)          Offscreen doc               │
 voice/UI   │  shell, inbox, workflows,    mic + speech gate, wake     │
            │  agents, graph, settings     word, local STT/TTS, Live   │
            │        │ port: typed, zod-validated, request ids         │
            │  Background service worker = the ONE writer of state     │
            │   threads · gate · KB/graph · workspaces · brief          │
            │   NEW: model registry · secrets vault · jobs/scheduler    │
            │        connectors (MCP) · agents · workflow engine        │
            │        inbox · run log · usage per agent/workflow         │
            └───────────────┬──────────────────────────────────────────┘
                            │ http://127.0.0.1 (pairing token + origin)
            ┌───────────────▼──────── Mac: "Nex Brain" companion ───────┐
            │ agent sessions · Docker sandbox per agent · CLIs · stdio   │
            │ MCP · runs workflows with Brave closed · builds artifacts  │
            │ "Avi Studio": local pages opened in a tab for whatever the │
            │ extension cannot host (previews, eval-needing tools)       │
            └────────────────────────────────────────────────────────────┘
```

- The extension works with no companion: workflows, agents, MCP over HTTP, inbox, voice, graph all run in the browser.
  The companion adds what a browser cannot do and degrades to "start Nex Brain" when it is not running.
- **Agent** = profile (instructions, skills, allowed connectors/tools/domains, model role, workspace, triggers,
  budget). Browser work runs through ThreadManager in a **separate, unfocused agent window** (never Avi's tab, one run
  slot always kept for Avi); sandbox/CLI work goes to the companion. One abstraction, two executors.
- **Workflow** = typed DAG (`WorkflowSpec`, zod). The engine is pure TypeScript shared by the extension and the
  companion, so a workflow can run with Brave closed.
- **Pages beyond the panel:** big views (graph, workflow editor, agent log) open as full-tab extension pages; anything
  the extension's CSP forbids opens as an "Avi Studio" page served by the companion on 127.0.0.1, authenticated with a
  one-time token in the URL fragment, no extension privileges.

## Engineering contract (Phase 0a ships it as code + `.claude/skills/avi-conventions/SKILL.md`)

**State**
- Background is the single writer; others send commands. Panel reads Dexie with `useLive`, settings with
  `createStorage` + `subscribe`.
- Every boundary message is a zod discriminated union in `src/shared/protocol/` with a `requestId` (idempotency);
  invalid messages are dropped and logged; panel requests time out.
- Long-running work is a persisted state machine: `Run: queued → running → waiting_user → succeeded | failed |
  cancelled | interrupted | unknown_outcome`, leases + heartbeats; `recover()` on worker start resumes or marks it.
- **Registration points** so streams never edit the same file: `registerCommand`, `registerRecovery`, `registerJob`,
  `registerAction` (schema + prompt text + where it may run), `registerGateKind` + `reviewToolCall` (non-page gate),
  `registerPlace`, `registerSettingsSection`, `registerVoiceTool`, `registerOffscreenBusy`. Each stream gets an empty
  `register.ts`, imported synchronously at startup (MV3 listeners must exist in the first tick).
- Dexie v5 (lead only bumps versions): new tables `agents`, `workflows`, `runs`, `runSteps`, `jobs`, `inbox`
  (unique `[source+externalId]`), `bus` (with hop count), `connectors`, `toolFingerprints`, `artifacts`,
  `modelCatalog`, `usageEvents`, `logs`; optional `agentId` + `origin` on threads, meetings and kbItems (graph nodes
  derive it from `sourceItemIds`). Upgrade tested on fake-indexeddb from a v4 snapshot.

**Errors** — `AppError { kind: network | timeout | rate_limit | quota | auth | forbidden | invalid | not_found |
unavailable | cancelled | budget | unknown_outcome | unknown, retryable, retryAfterMs?, cause }` and `toAppError()` for
AI SDK, fetch, MCP and companion errors. The UI shows a plain sentence and a fix; logs keep the cause; never secrets or
full prompts. `ErrorBoundary` per panel route.

**Retry** — `withRetry(fn, policy)` in `src/shared/retry.ts`: full-jitter back-off `min(cap, base·2ⁿ)·rand()`,
`Retry-After` in seconds *and* HTTP dates, `AbortSignal`, retryable kinds only. **One layer per error class** (the
model call keeps the meter's layer; steps don't wrap it again). Waits over 20 s become jobs, never in-memory sleeps.
Non-idempotent side effects are never auto-retried; a side effect cut off mid-call becomes `unknown_outcome` and an
Inbox item. Per-host circuit breaker (5 failures / 60 s → open, half-open after 2 min) kept in `storage.session`.

**Credentials and platform**
- `secrets` vault in its own IndexedDB (`avi-secrets`): AES-GCM with a non-extractable WebCrypto key; only the
  background decrypts; UI shows `••••last4`; never to content scripts, pages, the model, logs, the Obsidian export or
  KB export. Honest scope: it takes keys out of `storage.local` (readable by content scripts) and off disk as
  plaintext; it does not stop code already running in an extension page. Migration verifies decrypt before deleting
  plaintext. Gemini Live moves to ephemeral tokens.
- **Pin the extension ID** (manifest `key` = public key of a key pair kept out of git) — once, now.
- MCP OAuth 2.1 + PKCE via `chrome.identity.launchWebAuthFlow` (`identity` permission), PKCE state persisted,
  single-flight token refresh per connector, "Reconnect" Inbox item when a token dies; registered clients where
  dynamic registration isn't offered (Slack, GitHub, Google — Google as an Internal app on Nexprove's Workspace).
- Tool **fingerprints** (name + description + schema hash); a changed tool is off until re-approved.
- **Prompt injection once agents act:** runs started by untrusted events (inbox, tab watcher, connector, bus) are
  *tainted* and the taint follows messages between agents; untrusted output is data, never pasted into instructions or
  tool args; each agent has a domain allowlist; inbox content is summarised by a tool-less model into a fixed schema;
  agents and workflows can only be created or changed from attended chat, with a diff to confirm; connectors are bound
  to workspaces.
- Every side effect passes the gate: attended → confirm card; unattended → Inbox approval. MCP tools are "write"
  unless Avi marks them read-only. GitHub commits/push: approval + secret scan, no override.
- **Artifacts** render in a manifest `sandbox` page with CSP `default-src 'none'`, inline script/style only,
  `img-src data: blob:` (no network: an artifact cannot send data out); companion previews get `CSP: sandbox`.
- Companion: binds 127.0.0.1 explicitly, fail-closed auth, origin check, rate limits; CLIs (node, python, pnpm) run
  only inside the Docker sandbox; on the host only `gh` with a subcommand allowlist.
- Workspaces never mix: every agent, workflow, run, inbox item, connector and KB item carries `workspaceId`.

**Cost** — every caller asks for a model *role*, never an id. Budgets: daily cap covers every provider (prices from
the registry, local models free, unknown → token cap), a separate background budget, per-workflow and per-agent caps,
runs-per-day limits, auto-pause after N failures, a catch-up window (a missed 07:30 run doesn't fire at 22:00), bus hop
limit. Voice: speech gate (done), idle end for every conversation (default 3 min), live cost shown in the voice screen.

**Observability** — redacted `logs` table with run and request ids, a Jobs & breakers page, "Copy diagnostics".

**Quality gates per stream** — type-check, lint on touched files, unit tests, E2E in Brave (glob of `e2e/*.e2e.mjs`),
i18n keys under the stream's prefix in all three locales (key-union merge + equality check), zero CSP violations per
context, security review, screenshots for UI, a `docs/task.md` section, commit as AviOfLagos with attribution.

## Workstreams

Each stream owns directories; no one edits another stream's files; hot files change only through the registration
points. Each subagent works in its **own git worktree** (bootstrap script copies the git-ignored `public/wake`,
`public/voice`, `.env.local`), never loads branch builds into Avi's profile, and hands back a branch with tests passing.
New dependencies are installed by the lead before each wave (Wave A in Phase 0a, Wave B before it starts; the 72-hour
release-age rule applies), so no stream touches `package.json` or the lockfile.

| Stream | Owns | Wave | Effort |
|---|---|---|---|
| **0a Foundations** (lead) | `src/shared/{protocol,errors,retry}`, registration points, Dexie v5 types, `jobs`, deps, ID pin, conventions skill, mocks | 0 | 1.5 |
| **WS3 Models, vault, usage** | `background/{llm,models,usage}`, `storage/lib/{settings,secrets,usage}`, `ModelSettings.tsx` → `useProviders` | A | 3 |
| **WS6 Graph** | `side-panel/kb/*`, `background/graph/*` | A | 1 |
| **WS2 Voice out & retry** | `side-panel/chat/*`, `background/tts/*`, `offscreen/tts.ts` | A | 1.5 |
| **WS1 Shell & account** | `side-panel/{layout,settings,workspaces,account}/*` | A | 1.5 |
| **WS5a Workflows** | `background/workflows/*`, `storage/lib/workflows/*`, `side-panel/workflows/*` | A | 2.5 |
| **WS4 Integrations** | `background/integrations/*`, `storage/lib/integrations/*`, `side-panel/integrations/*` | B | 3 |
| **WS5c Inbox & sources** | `background/inbox/*`, `storage/lib/inbox/*`, `side-panel/inbox/*` | B | 2.5 |
| **WS5b Agents & run log** | `background/agents/*`, `storage/lib/agents/*`, `side-panel/agents/*` | B | 2 |
| **WS8 Voice engines** | `offscreen/{stt,tts-local}/*`, `background/voice/engines/*`, `scripts/voice-models-setup.mjs` | B | 2.5 |
| **WS7 Nex Brain** (after spike) | `companion/**`, `src/background/companion/*` | B | 4 |
| Integration by lead | merges, seams, full E2E | — | 2.5 |

Effort is relative (WS6 = 1); total ≈ 28.

**WS3 Models, vault, usage** — discovery job (start, every 6 h, on key change, on demand) for Ollama `/api/tags`,
LM Studio `/v1/models`, OpenRouter `/api/v1/models` (prices, context, modalities), NVIDIA `/v1/models`, OpenAI,
Anthropic, Gemini, xAI, DeepSeek, any OpenAI-compatible URL → `modelCatalog` with capabilities, price, `local`,
health. Presets for NVIDIA, LM Studio, Together/Groq-style endpoints; local probe of `:11434` / `:1234` with the
`OLLAMA_ORIGINS` hint. Roles `fast | smart | vision | local | embed (pinned) | transcribe | realtime | tts | search`
via `resolveRole()` with fallbacks (cloud down → local). Vault + migration; usage v2 (`usageEvents`, per model / agent
/ workflow / workspace / day, all-provider cap); `useProviders` hook for the panel page.

**WS6 Graph** — `react-force-graph-2d`: live physics, drag, zoom/pan, hover highlights neighbours and dims the rest,
click focus (focus card + trail kept), curved links with soft particles, labels by zoom, size by degree, theme
colours, fit / centre, level of detail up to 2 000 nodes, full-tab pop-out. Filters: workspace, agent, type, time.

**WS2 Voice out & retry** — TTS interface `speak(text, {voice, rate})` / `stop()` with **system voices** via
`chrome.tts` (default; whole answer queued up front with `enqueue`) and **Gemini TTS** (offscreen playback; offscreen
kept open while speaking). Markdown stripped to speakable text, one speaker at a time, talking interrupts. Speak/stop
on every answer and the brief; setting **Read results aloud: Off / When I used voice / Always**. **Retry**
(`thread_retry`: re-runs the last task with a fresh executor, carrying what was already approved and sent so nothing
goes twice) under answers, in a failed turn's run trail and in ThreadBar's error strip; **Retry from here** on user
messages (fork + run).

**WS1 Shell & account** — drawer top: New chat, search, Home, Inbox (badge), Today, Meetings, Workflows, Agents; chats
by date. Bottom: profile button → upward popover: Knowledge base, Workspaces, Connectors, Skills, Models & usage,
Settings, How do I…. One Radix `DropdownMenu`-based row menu (portal, solid `bg-popover` + blur, collision-aware,
Esc / click-outside / focus) used everywhere. Workspaces page with **default workspace** (migration sets Nexprove once)
used by new chats, background runs and routing fallback. Models & usage page on WS3's hook. Settings regrouped;
breadcrumbs for the new places.

**WS5a Workflows** — `WorkflowSpec` nodes: `trigger.schedule | trigger.tab | trigger.event | trigger.manual`,
`step.browse`, `step.http_get`, `step.web_search` (provider grounding, fallback `search_google`), `step.read_page`,
`step.memory_search`, `step.memory_save`, `step.tool`, `step.agent`, `step.llm`, `step.condition`, `step.sandbox`,
`out.inbox`, `out.brief_section`, `out.notify`, `out.speak`; edges carry data (`{{steps.news.output}}`). Engine on the
jobs runner: per-step state persisted, step retry policy, side-effect steps → approval, budget + max steps,
cancellation, versioned drafts. Authoring: `create_workflow({request})` / `update_workflow({id, change})` /
`run_workflow` / `list_workflows` actions trigger a **separate structured-output call** that writes the spec (the spec
never enters the navigator's output schema); the panel shows the **React Flow (`@xyflow/react`) diagram** with dagre
layout, a diff and "Create"; node edits by hand; runs light up nodes live; full-tab editor. Template "Morning tech
news": 07:30 → Hacker News (Algolia API) + Hugging Face (papers / trending API) → summarise → brief section; the brief
waits for or appends sections of workflows due before it.

**WS4 Integrations** — remote MCP (Streamable HTTP, `@modelcontextprotocol/sdk` + `CfWorkerJsonSchemaValidator`, one
client per call, re-init on expired session), OAuth or vault token; companion-proxied stdio MCP and CLIs (WS7).
Catalogue page (Slack, Gmail, Google Calendar, GitHub, Notion, Linear, Drive + custom URL); per tool: read-only /
needs approval / off; fingerprints. Agent action `call_tool({connector, tool, args})` with a compact tool catalogue in
the prompt, JSON Schema validation of args, untrusted results, timeouts, reads-only retry, breaker per server.
Mock MCP server for tests (changed tool, 429, slow tool, injection payload, OAuth shim).

**WS5c Inbox & sources** — items (source, kind: message | approval | result | alert, title, body untrusted, links,
priority, status, workspace, agent); Inbox page with filters and inline approve/decline; dedupe, per-source rate
limits and digests, notification throttling, retention job. Sources: connector pollers (Slack mentions/DMs, Gmail
important, GitHub reviews) and **tab watchers** for WhatsApp Web, Slack web, Gmail web (reads new messages from an
open tab with the user's session, no API key). **Speaking up:** an announcer turns high-priority items, approvals and
meetings about to start into a short spoken line (Live if on, else local TTS), with quiet hours, a rate limit and a
"Speak up when something needs me" switch.

**WS5b Agents & run log** — profiles + `create_agent` / `update_agent` actions (attended only, diff to confirm);
triggers (schedule, watched URL pattern, inbox/event, bus topic); each agent's browser work in its own tab group inside
the agent window ("agent tabs"); bus between agents (persisted, at-least-once, dedupe, hop limit, taint carried);
agent page: status, tabs, runs, knowledge, usage; **run log** timeline per run/agent (steps, tool calls, model,
tokens, cost, errors, retries); voice tools for inbox, workflows and agents.

**WS8 Voice engines (free and local options)** — engines chosen in Settings › Voice:
- *Speech-to-text:* Gemini (cloud, today), **Moonshine** (local, transformers.js WebGPU/WASM), **Whisper base**
  (local), **Vosk** (local, already shipped for the wake word). Brave has no Web Speech recognition.
- *Text-to-speech:* system voices (`chrome.tts`, WS2), **KittenTTS** (local, ~25 MB, 8 voices, `kitten-tts-js` on
  onnxruntime-web; eSpeak phonemizer checked for eval like the Vosk worker), **Kokoro** (local, higher quality,
  bigger), Gemini TTS (cloud), Gemini Live native audio (cloud, today).
- **Economy voice mode:** local speech-to-text → any text model with the same voice tools (incl. local Ollama) →
  local voice. Audio never goes to a paid model; cost is text tokens only, or nothing with a local model.
- Models fetched by `scripts/voice-models-setup.mjs` with pinned SHA-256s (git-ignored `public/voice/`), loaded on
  demand in the offscreen document; nothing leaves the Mac.
- `end_conversation` voice tool (free, never gated) and idle end for every conversation.

**WS7 Nex Brain** — starts with a **one-day spike** with exit criteria: Eve model config per session (only
`defineDynamic` / the `step.started` hook can return a live model such as Ollama or NVIDIA), per-session
instructions and tool allowlists via `clientContext`, sandbox isolation per session, runtime-created schedules,
`inputResponses` approvals → Inbox, fail-closed `AuthFn` bound to 127.0.0.1, stream resume, Docker/OrbStack egress
rules, no telemetry, nothing secret in persisted session inputs. **Fallback:** plain Node with the AI SDK
`ToolLoopAgent`, dockerode and croner behind the same `src/shared/protocol/companion.ts`. Then: pairing (one-time code
in Settings › Connectors), health, sessions + stream, cancel, retry + breaker; sandboxed CLIs; stdio MCP proxy;
workflows that run with Brave closed (shared engine); artifacts (build in the sandbox → Avi Studio preview tab or the
sandboxed artifact page); LaunchAgent; Docker check with a clear "start Docker Desktop" message. Docker is installed
here but its engine was not running.

### Order

Phase 0a → **Wave A** (WS3, WS6, WS2, WS1, WS5a in parallel; WS5a against a stub `resolveRole`) → merge
WS3 → WS6 → WS2 → WS1 → WS5a → **Wave B** (WS4, WS5c, WS5b, WS8 in parallel; WS7 spike in parallel, build after)
→ merge WS4 → WS5c → WS5b → WS8 → WS7. After every merge: type-check, all unit tests, full Brave E2E, security
review; the lead fixes seams. Wave A delivers the headline (workflows + diagram) early; Wave B wires it to the world.

### How the subagents run

- One `general-purpose` subagent per stream, `isolation: worktree`, in the background, model per the decisions
  below. At most 5 at once (session guideline < 10).
- Each brief = the stream section above + the conventions skill + owned paths + "do not touch" list + acceptance
  tests + the skills to load: `avi-conventions` always; `award-tier-ui` for WS1/WS6/WS5a UI; `mcp-builder` for
  WS4/WS7; `web-artifacts-builder` for WS7 artifacts.
- Each returns: branch name, what changed, tests run with results, open questions, and any change it needs in a file it
  does not own (the lead makes it).

## Verification

- Per stream: its unit tests + the E2E it adds (mocks: MCP server, model-list/pricing/TTS routes in `mock-llm.mjs`,
  companion mock speaking the protocol, fake clock for cron incl. DST and catch-up, worker killed mid-step).
- End to end in Brave after Wave A: "Every morning at 7:30 check Hacker News and Hugging Face and put the best in my
  brief" in chat → diagram shown → Create → run now → nodes light up → brief has the section → Read aloud speaks it →
  Retry re-runs it; the graph drags/zooms; the drawer's profile menu reaches Models & usage with live models listed.
- After Wave B: connect a mock MCP server, a tab watcher posts to the Inbox, an agent with a schedule runs in the
  agent window and logs its run; economy voice mode answers with no audio sent to a paid model; with the companion, a
  workflow runs with Brave closed and an artifact opens in an Avi Studio tab.
- Security checks: no secrets in `storage.local` after migration, a changed MCP tool is disabled, a tainted run cannot
  send without approval, an artifact cannot load a remote image, CSP violations = 0.

## Decisions (Avi, 2026-10-12)

1. **Scale:** five subagents per wave, models matched to the work: **Sonnet** for well-specified streams (WS6 graph,
   WS2 voice out & retry, WS1 shell, WS8 voice engines, WS5c inbox), **Opus** for design-heavy ones (WS3 models/vault,
   WS5a workflows, WS4 integrations, WS5b agents, WS7 companion). Reasoning effort per subagent cannot be set from the
   lead; the briefs are written to keep each task bounded instead.
2. **Read aloud:** automatic when Avi used voice; a speak button on every other answer.
3. **Pin the extension ID now** (Phase 0a): data starts fresh once more; re-enter the Gemini key after.
4. **Usage:** tracked per agent, workflow, workspace and model on this Mac; no multi-user server.
