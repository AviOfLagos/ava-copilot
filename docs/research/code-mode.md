# Code mode and fewer tool tokens for Ava

Research and measurement, written 2026-11-22. No code was changed. Related: [tool-awareness.md](tool-awareness.md), [memory.md](memory.md).

## Summary for the owner

1. **What was published.** Cloudflare (Sept 2025) and Anthropic (Nov 2025) found that an AI spends far fewer tokens if it sees a short list of tools and writes a small program that uses them, instead of being shown every tool every time. Cloudflare reports about 1,000 tokens in place of 1.17 million for its own huge API. Anthropic reports 98.7% less in one example, and 37% less on harder real tasks.
2. **What Ava spends today (estimate, not a meter reading).** Every browser step, in the panel, on WhatsApp, in agents and in routines, carries roughly 15,000 to 20,000 tokens of tool definitions and rules before the page is even read. A voice conversation starts with about 8,000. WhatsApp pays the same as the panel for a one-line question.
3. **Recommendation.** Do not start with a code sandbox. First trim, cache and load rarely used tool groups on demand: about half of the per-step tool cost, and it ships in small steps. Then pilot code mode, read-only tools first, using a tiny JavaScript engine compiled to WebAssembly, and only if measurements show enough multi-step data jobs to pay for it.
4. **Safety stays.** Every send, post, delete, spend or share still needs its own click, one per side effect, even inside a program. A repeated program cannot repeat a side effect. Words from pages are data. Secrets never enter a program.
5. **Not worth it when:** most runs are page-driven (each step needs a fresh look at the page), fewer than about one run in five chains three or more non-browser tools, or the models Avi uses write code badly. The first issue is to measure this properly.

---

## 1. What was published

All numbers below are the authors' own. I found no independent benchmark. Every page was read on 2026-11-22.

### 1.1 Cloudflare

| Page | Date | What it adds |
|---|---|---|
| [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) | 2025-09-26 | The idea. |
| [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/) | 2026-02-20 | Server-side version for the whole Cloudflare API. |
| [Dynamic Workers](https://blog.cloudflare.com/dynamic-workers) | 2026-03-24 | The sandbox as a product; price; security notes. |
| [How Code Mode works](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/) (docs) | page says modified 2026-10-12 | Approvals, replay, rollback, limits. |

**Problem.** Models are trained on special tool-call tokens and on little real tool-call data, but on a great deal of real code. The post says agents "handle many more tools, and more complex tools" when tools look like a TypeScript API. When tools are chained, each result normally passes through the model just to be copied into the next call.

**How tools become an API.** The Agents SDK reads an MCP server's schema and writes a TypeScript declaration with doc comments. In the first version the whole declaration goes into the model's context (the post says searching it "could" come later). The model sees one tool: "run this TypeScript".

**Where code runs.** In a V8 isolate (a light JavaScript sandbox, started in milliseconds, new for every snippet, thrown away after). It has no internet: `fetch()` and `connect()` throw. Its only way out is "bindings", live objects that call back into the agent loop by RPC, which holds the real credentials. So the code never sees an API key.

**How results flow back.** The code calls `console.log()`; the logs are the result the model reads. The model never sees intermediate data it did not log.

**Numbers.**
- Second post: the Cloudflare API has over 2,500 endpoints. As ordinary MCP tools it would cost 1.17 million tokens; with two tools, `search()` and `execute()`, about 1,000 ("99.9%", measured with tiktoken). The model writes JavaScript to search the OpenAPI spec, then to call the API.
- Third post: "converting an MCP server into a TypeScript API can cut token usage by 81%". The first post's text I fetched has no number (it may be in an image), so I could not confirm 81% at its source.
- Price: $0.002 per unique Worker loaded per day, plus CPU and invocations; waived in beta (third post).

**Limits and failure modes the docs state.**
- The runtime, not the sandbox, holds state. A resumed run executes the code again in a new isolate ("replay"), so side effects must be recorded. Rollback "is compensation, not database transaction isolation".
- Every connector call is intercepted by the runtime, which applies approval, logging, replay and rollback. Execution failures come back to the model as data. Stored values are capped at 1,000,000 characters.
- Third post: hardening an isolate sandbox "is tricky"; V8 bugs are more common than hypervisor bugs, so extra layers are needed.
- Second post compares alternatives. Tool search, they say, "requires a search function that must be maintained and evaluated", and each matched tool still uses tokens. Shell/CLI approaches need a shell and widen the attack surface.

### 1.2 Anthropic

| Page | Date | What it adds |
|---|---|---|
| [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) | 2025-11-04 | The same idea, as files on disk. |
| [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) | 2025-11-24 | Tool search tool, programmatic tool calling, tool use examples. |
| [Managing context](https://www.anthropic.com/news/context-management) | 2025-09-29 | Context editing and the memory tool. |
| Docs: [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling), [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool), [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) | undated, read 2026-11-22 | Current rules and limits. |

**Code execution with MCP.** Tools become files (`servers/google-drive/getDocument.ts`). The agent lists the folder and reads only the files it needs, then writes code that calls them. Example: 150,000 tokens down to 2,000 ("98.7%"). That is one worked example, not a benchmark. They also describe a `search_tools` tool with a detail level, privacy by replacing personal data with tokens before the model sees it, and saving reusable code as "skills". They warn that running agent code needs "sandboxing, resource limits, and monitoring" and that this is overhead direct tool calls avoid.

**Tool search tool.** You send all definitions but mark most `defer_loading: true`; the model gets a search tool (regex or BM25), and matching tools are expanded into full definitions (up to 5 per search by default; at least one tool must stay non-deferred). Their five-server setup (58 tools) costs about 55,000 tokens in definitions before any work; the docs say search "typically reduces this by over 85 percent". In a separate scenario (50+ tools, about 72K of definitions) the post goes from about 77K total to 8.7K, an "85% reduction". Accuracy on their MCP evaluation: Opus 4 from 49% to 74%, Opus 4.5 from 79.5% to 88.1%. It does not break prompt caching because deferred tools are never in the cached prefix. They say it is less useful under 10 tools or when all tools are used every time.

**Programmatic tool calling.** Tools marked `allowed_callers` can be called from Python that Claude writes and runs in Anthropic's code-execution container. Each tool call pauses the code, your server answers, and the answer goes to the code, not the model. Only the final printed output reaches the model. Reported: average 43,588 to 27,297 tokens (37%) on complex research tasks; knowledge retrieval 25.6% to 28.5%; GIA benchmark 46.5% to 51.2%. Docs limits: `allowed_callers` is "not a hard API-level block", so do not use it as a security boundary; a pending tool call times out after about 4 minutes; containers expire after 30 days; and the docs' data-retention note says it is "built on code execution containers; data retained up to 30 days". It works only with Claude models, on Anthropic's platform and some partner clouds.

**Memory tool and context editing.** The memory tool is a folder (`/memories`) the model reads and writes through ordinary tool calls that your own code executes (files, a database, anything). Your handler must reject paths outside `/memories`; the docs say Claude "usually refuses" to store sensitive data and you should strip it yourself. Context editing removes old tool results (`clear_tool_uses_20250919`, with `trigger`, `keep`, `clear_at_least`, `exclude_tools`) and old thinking. Reported on an internal agentic search test: memory plus editing 39% better than baseline, editing alone 29%; in a 100-turn web search test editing cut tokens 84%. The docs now call server-side compaction "the primary strategy" for long conversations, with editing for specific cases. Clearing results breaks the cached prefix, hence `clear_at_least`.

### 1.3 What I could not confirm

- The 81% figure at its origin (first Cloudflare post), see above.
- Any independent benchmark of either company's numbers.
- Whether the Gemini Live setup (Ava's voice engine) can change its tool list mid-session. I did not read that page.
- How long a WebAssembly JavaScript engine takes to start inside Ava's offscreen document. Not measured.
- Anthropic's API features (tool search, programmatic calling, context editing) only work with Claude models (through Anthropic's API and some partner clouds). Ava reaches models through the Vercel AI SDK (`package.json`: `ai` 7.0.126), and its browser agent asks for one JSON object back (structured output), not native tool calls (`src/background/agent/agents/navigator.ts:59-68`). So the pattern applies; the API features do not apply directly.

---

## 2. Where Ava is today, measured

### 2.1 Method and honesty

I tried to run a script that builds each channel's real tool list and counts it. The permission system refused that run, so I deleted the script. These numbers come from the **source text** instead:

- Tokens are estimated as **characters divided by 4**. The repo's own estimator uses 3 characters per token (`src/background/agent/messages/service.ts:27`); at 3, every figure here is up to a third higher. No tokenizer is installed in the repo (the dependency list has none). Real counts will differ by about ±25%.
- Declarations were found by a script that reads every `name: '…'` block under `src/background` (found 85 chat actions and 64 voice tools; the script is not committed). TypeScript source is shorter than the JSON Schema a model receives: each action repeats an `intent` field, the navigator adds a `title` to every property, and each action is wrapped as nullable and optional (`src/background/agent/actions/builder.ts:141-152`, `agents/navigator.ts:59-68`). I use source size as the floor and 1.5 times as the middle estimate.
- Issue 1 asks for a real measurement (a test that prints the size of every prompt part), so these estimates can be replaced.

### 2.2 Where tools are defined

| Place | Count | Where |
|---|---|---|
| Browser steps built in (click, scroll, tabs, done, …) | 20 in one file | `src/background/agent/actions/schemas.ts` |
| Built-in, from other folders (graph, reader, form fill, knowledge) | 5 | wired in `src/background/agent/actions/builder.ts:163-780` |
| Actions that features register | 60 | `registerAgentAction` in `src/background/registry/index.ts:106-110`, called from 22 files; added to the list at `builder.ts:780` |
| Voice tools, fixed | 19 | `VOICE_TOOLS` in `src/background/voice/prompt.ts:61-213` |
| Voice tools, registered | 45 | `registerVoiceTool` (`registry/index.ts:159`) |
| Connector tools | per connector, one action `call_tool` plus a list in the step state | `src/background/integrations/action.ts`, `catalogue.ts` |
| Workflow node kinds | 20 (12 steps, 4 triggers, 4 outputs) | `src/background/workflows/spec.ts` |

### 2.3 Per channel

There is **no per-channel tool filter**. Every chat is run by the same planner and navigator (`threads/factory.ts:192-194`, `agent/executor.ts:128`). The chat's origin (user, voice, whatsapp, agent, workflow, brief) only changes one paragraph of text (`agent/prompts/channel.ts:19-27`). So WhatsApp, agents and routines carry the same 85 actions as the panel.

| Channel | Tools sent | Tool definitions per call | Instructions per call | Total fixed, per call |
|---|---|---|---|---|
| Panel chat, navigator (per step) | 85 actions | 9.3k floor, about 14k middle | about 6k (about 24k characters including the capability list; see below) | **about 15k to 20k** |
| Panel chat, planner (every 3rd step, `planningInterval` 3, `generalSettings.ts:39`) | none | 0 | about 2.5k | **about 2.5k** |
| WhatsApp | same as panel (origin `whatsapp`) | same | same, plus 0.4k WhatsApp paragraph | **same as panel**; messages handled in code cost 0 (`whatsapp-remote/commands.ts`, `task-commands.ts`) |
| Agents and routines (`step.agent`, background chats) | same 85 | same | same | **same as panel** |
| Routine `step.llm` (also on Ava Brain) | none | 0 | the step's own text | small |
| Voice (Gemini Live), at session start | 64 declarations | 5.6k (22.5k characters, plain JSON) | about 1.5k rules + about 0.5k "what you can do" | **about 8k**, carried for the whole session |
| Connectors, added to every navigator step | `call_tool` plus a list | 0.2k + list | up to 6,000 characters of list (1.5k tokens) | **up to 1.7k extra** (`catalogue.ts:14-16`) |

How the navigator's 24k characters add up: rules template 7,709, gate 1,030, page reader 590, knowledge 1,193 (`agent/prompts/templates/navigator.ts`, `gate/prompt.ts`, `reader/reader.ts`, `kb/action.ts`); the prompts that about 26 features add, about 10k (an estimate: 18 named constants sum to about 7.8k and the rest are inline strings, `registry/index.ts:131-135`); the channel paragraph, about 1.6k; and the capability list ("what you can do"), which is also added to the navigator's rules (`capabilities/register.ts:396-413`), estimated at about 2k. Not counted: the "about you" identity section (up to about 6k characters, about 1.5k tokens, see memory.md), the user's style and personality, the page, the history, and the per-step lists (skills, workspace, team of up to 12 lines, connector list).

The biggest single declarations are growth-team and product tools (`sort_feedback` 1,439 characters, `update_product_profile` 1,284, `metrics_query` 1,238, `request_tool` 1,107, `queue_for_approval` 1,101). The 15 growth and growth-team actions alone are about 10.3k characters, about 2.6k tokens to 3.9k tokens on every step of every chat, including a WhatsApp message asking for the time.

Nothing is cached on purpose. I found no `cache_control`, `cacheControl` or cached-content request in `src/background` (the only "ephemeral" hit is an unrelated Gemini token). Some providers cache automatically when the start of a request is identical; Anthropic's needs a marker. Whether Ava's stable start (rules, then tools) is identical from step to step is likely but not checked.

Usage is metered per model call with the role and input and output tokens (`src/background/usage/meter.ts:95-173`, role field at `:31`), stored by day and by chat session (`src/storage/lib/usage/index.ts:17-22`). It does not say which part of the prompt was the tools, so Avi cannot see "tool tokens" as a number today.


### Measured (issue #130)

Real sizes from `src/background/prompt-budget` (run `pnpm test -t "size of what each channel sends"`; the test fails when a channel or a part grows by more than 10% against `baseline.json`, and `UPDATE_PROMPT_BUDGET=1` rewrites it). Tokens are characters divided by four. These replace the estimates above; page state and the conversation are not counted. Tool definitions are the JSON Schema of every action; the workspace row uses the longest "about" the app keeps (4,000 characters).

| Channel | Tool definitions | Rules, identity, channel, capability list | Workspace block | Total fixed |
|---|---:|---:|---:|---:|
| panel navigator | 53,197 ch (~13,300 tok) | 27,793 ch (~6,949 tok) | - | **80,990 ch (~20,248 tok)** |
| panel navigator, in a workspace | 53,197 ch (~13,300 tok) | 27,793 ch (~6,949 tok) | 4,773 ch (~1,194 tok) | **85,763 ch (~21,441 tok)** |
| whatsapp navigator | 53,197 ch (~13,300 tok) | 28,409 ch (~7,103 tok) | - | **81,606 ch (~20,402 tok)** |
| agent and routine chats | 53,197 ch (~13,300 tok) | 27,874 ch (~6,969 tok) | - | **81,071 ch (~20,268 tok)** |
| panel planner | 0 | 12,132 ch (~3,033 tok) | - | **12,132 ch (~3,033 tok)** |
| voice | 22,321 ch (~5,581 tok) | 6,103 ch (~1,526 tok) | - | **28,424 ch (~7,106 tok)** |

---

## 3. The proposal for tool tokens

### 3.1 Three options compared

| | (a) Load tools on demand | (b) Code mode | (c) Trim and cache |
|---|---|---|---|
| Idea | Keep about 25 core actions always. The rest are found with a `find_action` step that adds their definitions for the rest of the run. | The model writes one short program against a typed API and it runs in a sandbox. | Shorter descriptions, drop unused fields, one shared `intent`, cache markers, leave growth and meeting tools out of chats that cannot use them. |
| Saving on the navigator | about half of the fixed cost: 8k to 11k tokens a step | adds nothing for page work; saves intermediate data in multi-call data jobs | 10% to 25% on its own; more with caching |
| Effort | small to medium | large | small |
| Risk | the model forgets to search, or picks wrong; one more step for rare tools | new attack surface; hard to keep one click per effect; weak local models | very low |
| Fits Ava's structure | yes, but the one-JSON-schema design means the schema grows during a run | partly: Ava's workflow engine already is a typed program (see 3.3) | yes |

Estimate for (a) on the navigator: keep the 25 built-ins (2.4k to 3.6k tokens), add the search step (0.2k), keep the core rules, channel paragraph and capability list without the feature prompts (3.5k), plus about 1.5k for the groups a typical run loads. That is about 7.6k to 8.8k, against 15k to 20k now: **a saving of about 8k to 11k tokens per step, about half**. The prompts for the feature actions move into the definitions that load on demand.

### 3.2 Recommendation for tool tokens

**Do (c) and (a) first, in that order. Do (b) as a pilot after a measurement, not before.** Reasons:

1. Ava's main job is page work. Each step needs a fresh look at the page, so a program cannot batch it. Code mode pays on data jobs: tasks, people, metrics, Drive, knowledge, connectors, routines.
2. (c) and (a) are safe by construction: no new way to act.
3. Avi said code mode "is something that we have to do". The pilot in 3.4 is the smallest version that is safe and would show whether it pays.

### 3.3 Where code could run in Ava

The rules that decide this:
- The extension's pages may not build code from text. Their security rule is `script-src 'self' 'wasm-unsafe-eval'` (`wxt.config.ts:87`): WebAssembly is allowed, JavaScript `eval` and `new Function` are not. A comment in the integrations code says the same (`src/background/integrations/schema.ts:7`). Chrome's migration page says `eval` and `new Function` are still supported in sandboxed iframes ([improve security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)).
- A page declared in the manifest as a sandbox page has no access to extension APIs and talks to other pages only by `postMessage`, and may run `eval` ([manifest: sandbox](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)). The default sandbox rule is permissive; Ava would write a stricter one (it must keep the `sandbox` directive and must not allow same-origin). Ava's manifest has no sandbox page today. It does have an offscreen document (`wxt.config.ts:72`, `src/offscreen/`).

| Where | Isolation | Cost and limits | Verdict |
|---|---|---|---|
| **A. Sandbox page inside the offscreen document**, program run in a Worker that can be killed on a timeout | Chrome origin sandbox; no extension APIs; only `postMessage` out; a strict rule can also block network | Real JavaScript with `eval`; needs one new manifest entry; a new page to ship | Good second choice |
| **B. A JavaScript engine compiled to WebAssembly** (QuickJS is the usual one; I have not read its documentation here, so treat this as a candidate), in the offscreen document | The engine has nothing but what the host hands it; memory and time limits can be set; no browser APIs exist inside | About 1 MB added; plain JavaScript only (no TypeScript: the model writes JavaScript with type comments, or Ava strips types); needs no manifest change because `wasm-unsafe-eval` is already allowed | **Best first choice** |
| **C. Ava Brain (Node on the Mac)** | Docker sandbox: no network by default, read-only root, limits, only the workspace folder mounted (`companion/src/sandbox/docker.ts:16-40`, `sandboxRunArgs`) | Needs Docker running, Mac on, Brain connected; seconds to start; not for the interactive panel path | For routines only |
| **D. No code: a typed JSON plan run by the existing workflow engine** | Nothing is generated; each step is checked against a schema (`workflows/spec.ts:105-165`: `step.tool`, `step.agent`, `step.llm`, `step.condition`, `out.inbox`, …) with `{{steps.x.output}}` places for data | Fewer abilities than a program (no loops over many items, no arbitrary logic) | Best way to get 70% of the benefit with 10% of the risk |

Rejected: running `eval` in the background or panel pages (blocked), Node's `vm` module on Ava Brain (not a security boundary), Anthropic's container-based programmatic calling (Anthropic-only, keeps data up to 30 days per its docs, and `allowed_callers` is not a security boundary).

### 3.4 What a pilot looks like, and how the rules are kept

**Smallest first step that ships alone.** One new action, `run_program`, available only in chats whose model role is `smart`, with a typed API for **read-only** tools only: `task_list`, `metrics_query`, `drive_search`/`drive_read`, `search_knowledge`, `search_chats`, and connector tools whose policy is "runs freely". No chat action reads the people store today (only `person_note`, a write, exists), so people lookups would need a new read tool first. The program runs in option B. It returns what it printed, up to 10,000 characters (the same cap connector answers already have, `integrations/action.ts`, `AGENT_RESULT_CHARS`). No writes in the pilot, so the confirm gate is never in play yet. If it saves tokens and works, step two adds writes.

**Steps with side effects (step two).** A program cannot act except through functions the host binds. Each bound function is the existing action's handler, so it goes through `reviewAction` (`gate/review.ts:266`) exactly as today.
- *One decision per side effect.* A call that needs a click pauses that one call (its promise waits) and the panel shows that one effect. Approving it approves nothing else. A program that tries ten sends gets ten cards, one at a time. There is no "approve all".
- *Do-once keys.* Each effect is keyed by chat, program, call number and canonical arguments (`once/index.ts:162`, `beginOnce`). If the program is run again after a crash, finished effects are skipped and their recorded results returned. This is the same "replay" Cloudflare describes, and it needs the same discipline: the program must not use time or random values without recording them.
- *Words from pages are data.* A tool's answer enters the program as a value, marked as untrusted data like today (`wrapUntrustedContent`). The program text is written only by the model. A page's words are never joined into program text. A page can still sway what the model writes in a later turn, as today, so the gate shows the real arguments of every effect.
- *Secrets.* The engine has no environment, no network, no storage. Connector tokens and Ava Keys values stay in the host; the program calls `connectors.linear.list_issues(...)` and never sees a credential.
- *Usage.* The model call that writes the program is metered as now (`usage/meter.ts`). Add a counter per program: number of host calls, characters returned, and "calls it would have been" so the saving can be reported.
- *Models.* Roles are in `src/storage/lib/models/types.ts:2-12`. Allow `smart` only. Never `local` (small local models write code badly). `fast` only for read-only after a trial. Voice and WhatsApp-origin chats inherit the chat's role.
- *When it fails halfway.* The runner returns to the model: what finished (with the recorded results), the error, and that nothing else ran. It does not silently retry effects. After two failed programs in one run, the chat goes back to ordinary action calls and says so. A program that is still waiting for a click when Chrome unloads the offscreen document is lost; on the next run the do-once records make a rerun safe.

### 3.5 Estimated saving per channel

| Channel | (c) trim and cache | (a) on demand | (b) code mode, extra | Note |
|---|---|---|---|---|
| Panel chat | 1.5k to 4k per step | 8k to 11k per step (includes the part (c) overlaps) | unknown; only on data jobs | Combined (a)+(c): about 8k to 11k of 15k to 20k |
| WhatsApp | same | same, and highest value: short questions, many steps | none for page jobs | Plus leaving out tools that cannot work from a phone (tool-awareness.md) |
| Agents and routines | same | same | best fit: routines are data jobs | Many routine steps do not need a chat at all |
| Voice | 1k to 2k at session start (shorter descriptions) | not recommended: tools are fixed at session setup (not confirmed) and a search step adds delay | none | Voice already hands heavy work to `do_task` |
| Connector list | cap lower than 6,000 characters when few are used | already bounded; add search over the unlisted tools | the best fit | |

None of this is measured. Issue 1 gives the baseline; every later issue states the number it must move.

### 3.6 What would make code mode not worth it

- Less than about one run in five chains three or more non-browser tool calls (the usage meter cannot tell today).
- The first on-demand step already gets the cost low enough that the rest is noise.
- The models Avi actually uses fail to write correct programs more than about one time in ten.
- The engine's start time or size hurts the side panel or the offscreen document's memory.
- Anything that makes the click per effect weaker. If it cannot be kept one-to-one, stop.

---

## 4. First steps, measurement, and who builds it

| Step | Ships alone | Measured by | Model |
|---|---|---|---|
| Print the size of every prompt part per channel (a test, no behaviour change) | yes | tokens by channel in CI, and a limit that fails when it grows by more than 10% | sonnet |
| Shorter descriptions, one shared `intent`, move the about 26 feature prompts into the definitions | yes | fixed tokens per navigator step before and after on the same task set | sonnet |
| Cache markers and a stable prefix check | yes | cache-hit share in provider usage; cost per run | sonnet |
| Per-channel tool lists (WhatsApp and routines get only what works for them) | yes | actions sent per channel | sonnet |
| `find_action` and on-demand groups | after the above | tokens per step, and task success on a fixed set (must not drop) | opus (changes how the agent chooses) |
| Typed JSON plans for multi-step data jobs (option D) | optional | share of data jobs that finish in one run | opus |
| `run_program`, read-only, option B | after the baseline says it pays | tokens saved per program; failure rate; time | opus |
| Writes inside programs | after the above | zero ungated effects in a test that tries ten sends | opus |

## Sources

Fetched and read on 2026-11-22. Dates are the page's own publication date where it states one.

- Cloudflare, [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/), 2025-09-26
- Cloudflare, [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/), 2026-02-20
- Cloudflare, [Dynamic Workers](https://blog.cloudflare.com/dynamic-workers), 2026-03-24
- Cloudflare docs, [How Code Mode works](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/), modified 2026-10-12
- Anthropic, [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp), 2025-11-04
- Anthropic, [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use), 2025-11-24
- Anthropic, [Managing context on the Claude Developer Platform](https://www.anthropic.com/news/context-management), 2025-09-29
- Anthropic docs (undated): [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling), [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool), [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- Chrome for Developers (undated): [Manifest: sandbox](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox), [Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)
