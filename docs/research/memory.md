# Memory: what is published, what Ava has, what to change

Research, written 2026-11-22. No code was changed. Related: [code-mode.md](code-mode.md) (sources for the published features, token method), [tool-awareness.md](tool-awareness.md).

## Summary for the owner

1. **What is published.** Anthropic offers three ideas: a "memory tool" (the model reads and writes files that live on your side), "context editing" (throw away old tool results before they pile up), and "compaction" (summarise an old conversation). Their own test says context editing cut tokens by 84% over 100 turns.
2. **What Ava has.** Six memories already: facts about you, a knowledge base, a graph, people, tasks and workspace summaries. They are written by code with caps and sources, which is safer than letting a model write files. Ava does not need Anthropic's memory tool.
3. **What is wrong.** Up to 150 facts are stored but only about 1,500 characters of them are ever shown to the model, and I found nothing that searches the rest. A note can land in a place no chat reads. A long run is compacted only at about 77,000 tokens, so it pays for a big history on every step before that.
4. **Recommendation.** One "remember" front door that routes by code to the right store; one "recall" that searches all of them; clear old tool results early and compact at about a third of the window instead of 60%.
5. **First step.** Lower the compaction point and clear old action results after a few steps. Measure cost per run before and after. One small pull request.

---

## 1. What was published

Sources and dates are in [code-mode.md §1.2](code-mode.md). Summary:

| Feature | What it does | Reported result | Limits |
|---|---|---|---|
| **Memory tool** (docs, undated; announced 2025-09-29) | A folder `/memories`. The model makes ordinary tool calls (`view`, create, edit, delete); your code runs them against storage you choose. The model checks the folder before a task. | With context editing: 39% better than baseline on an internal agentic search test | Client-side only: you write the handler and must reject paths outside `/memories`. Claude "usually refuses" to store sensitive data; strip it yourself. Cap file sizes. Claude models only (Anthropic's API and partner clouds such as Bedrock and Vertex AI). |
| **Context editing** (docs; announced 2025-09-29) | Removes old tool results (`clear_tool_uses`) and old thinking when the window fills. Settings: `trigger`, `keep`, `clear_at_least`, `exclude_tools`. | Alone: 29% better; 84% fewer tokens in a 100-turn web search test | Clearing breaks the cached start of the prompt, so clear enough to be worth it. The docs now call server-side compaction the main strategy for long conversations. |
| **Compaction** (docs) | The server summarises older turns into one block. | Not quoted here (I did not read the numbers) | Claude models only. |
| **State and skills as files** (Anthropic, 2025-11-04) | In the code-execution post: write intermediate results to files, save reusable code as "skills". | none | Needs a code sandbox. |

I found no independent evaluation. The 84% and the 39% are Anthropic's own, on tests it describes as internal.

What matters for Ava: all three Anthropic features work only with Claude models (the announcement names Anthropic's API, Amazon Bedrock and Google Cloud's Vertex AI). Ava reaches many providers through the Vercel AI SDK (`package.json`: `ai` 7.0.126) and its browser agent uses one JSON reply per step, not native tool calls. So the *ideas* carry over (clear old results; keep memory outside the window; summarise), the *features* do not.

## 2. What Ava has today

Caps and paths verified in the code at commit `4bdb8c1`.

| Store | What is in it | Written by | Read by | What reaches the model | Workspace? |
|---|---|---|---|---|---|
| **About-you facts, goals, insights, core** (`src/background/identity/`, `src/storage/lib/identity/`) | `UserFact` {text up to 280, category, workspace, source `said`/`confirmed`/`settings`, status `active`/`proposed`}; up to 150 facts, 24 goals (3 per workspace), 20 insights; core character/values/purpose, 1,200 characters each (`storage/lib/identity/types.ts:32, 72-82`) | `remember`, `update_memory` (`identity/register.ts:188, 215, 301, 311`), the reflection job (`identity/reflector.ts:37`) | `loadIdentityContext` then `buildCoreSection` (`identity/context.ts:16`, `identity/prompt.ts:122`) | **Always, every call, every chat channel.** At most 1,500 characters of facts, 700 of goals, 500 of insights (`prompt.ts:26-28`), whole lines until full; workspace facts sort first (`prompt.ts:62-74`). With core fields the section can reach about 6,000 characters (about 1.5k tokens). | yes |
| **Knowledge base** (`src/background/kb/`) | Items and chunks (1,600 characters, 200 overlap), scope private/team/unowned (`kb/chunker.ts:12-14`, `storage/lib/threads/db.ts:392-393`) | Chats and meetings through hooks (`kb/manager.ts:221-271`); `save_to_knowledge`, `share_with_team` (`kb/action.ts:49-139`); voice `remember_this` (`voice/manager.ts:560`) | `search_knowledge`: up to 6 hits as a tool result (`kb/action.ts:28-46`) | Only when searched. Not in the prompt. | yes |
| **Graph** (`src/background/graph/`) | Entities and links built from KB items (8,000 characters per item, 15 names per item: `graph/builder.ts:21`, `graph/extract.ts:52`) | `GraphBuilder` | `look_up_graph`: at most 3 nodes (`graph/action.ts:59`) | Only when searched | yes |
| **Workspace summaries** (`src/background/history/`) | A summary per workspace from up to 15 sources of 1,400 characters (`history/summary-prompt.ts:7-8`), stored through the KB store (`history/summaries.ts:26-31`) | `workspace_context`, `history_summarize` (`history/action.ts:46-60`) | `workspace_context` action; voice `where_are_we` | Only when asked | yes |
| **Workspace record** (`storage/lib/workspaces/workspaces.ts:24, 153`) | `about` text up to 4,000 characters, accounts, product profile | the user | `workspaceSectionFor` (`workspaces/inject.ts`) | **Every navigator step** of a chat in that workspace: the whole `about` (up to 4,000 characters, about 1k tokens), accounts, product section | yes |
| **People** (`src/background/people/`) | names, aliases, identifiers; caps 20/20/60/20 (`storage/lib/people/store.ts:44-47`) | `person_note` (`people/register.ts:169, 198`) | tools and the task board "by person" | I found no place that puts people into a prompt (not exhaustive) | via chat |
| **Tasks** (`src/background/tasks/`) | tasks with workspace, owner, due; a "Close old" command closes open tasks older than 14 days (`storage/lib/tasks/store.ts:11, 325`) | task actions, meeting and graph sources (`tasks/sources.ts:30, 78`) | `task_list`, the board, WhatsApp commands | when asked | yes |
| **A run's own history** (`src/background/agent/`) | messages of the running task; old page states are removed after each step (`agent/agents/navigator.ts:153-201`) | the run | the model, every step | all of it, until compaction | thread |
| **Voice history** (`voice/prompt.ts:247-267`) | the tail of the previous voice chat | the chat | start of a voice session | at most 6,000 characters, 300 per line | thread |

**Compaction.** `maxInputTokens` is 128,000 (`agent/messages/service.ts:26`). Older steps are summarised once history passes 60% of that (`threads/compaction.ts:12`), keeping the last 12 messages and cutting each summarised message to 2,000 characters (`compaction.ts:14-15`). If still over budget the last message is cut, and the run fails above 99% (`service.ts:434-475`). So a long run routinely carries up to about 77,000 tokens of history on **every** step before anything is summarised. Per-step cost grows with history, because each step sends it again.

## 3. Where they overlap, disagree or lose things

1. **Stored but never shown.** Up to 150 facts of up to 280 characters can be stored; the prompt shows at most 1,500 characters (about 5 to 20 facts, depending on length). I found no tool that searches the facts. Tell Ava a 30th thing and it is saved, and no chat may ever see it. (Not exhaustive: I did not read every consumer of the fact store.)
2. **Three ways to remember, split by prose.** `remember` (a fact about you, always shown), `person_note` (a person), `remember_this` / `save_to_knowledge` (a page or note, only found by search) (`voice/prompt.ts:16, 20`). A fact the model files in the wrong place is lost to the places that matter: the fact is not shown if it went to the KB; a KB note is not found if it went to facts beyond the cap. The `person` fact category (`storage/lib/identity/types.ts:24`) overlaps with the people store.
3. **Chat text in three places.** Thread messages, KB chunks and graph nodes built from those chunks. Costs storage and indexing time, not prompt tokens.
4. **Two writers to the task board** (task actions and meeting/graph sources). Deduplication is presumed to be in `storage/lib/tasks/match.ts`; I did not read it.
5. **Summaries can lag.** Workspace summaries read a 600-character slice of the facts (`identity/prompt.ts:196-197`), so a fact told a minute ago may be missing from the next summary.
6. **Workspaces are kept apart in the always-on block.** `visibleTo` drops other workspaces' facts when the chat has a workspace (`identity/prompt.ts:40-42`) and a test covers it (`identity/__tests__/prompt.test.ts:89`). A chat in no workspace sees every fact, labelled by workspace.
7. **A large block on every step.** The workspace `about` (up to 4,000 characters) plus the identity section (up to about 6,000) together can reach 2.5k tokens on every call, before any tool.

## 4. Proposal

### 4.1 Cheaper long runs

| Option | What | Effect | Risk |
|---|---|---|---|
| a. Lower the compaction point | 60% to about 35% of the window (about 45k tokens) | Every long run carries less history | Summaries lose detail earlier; check on a fixed task set |
| b. Clear old action results first | Like Anthropic's context editing: after about 5 steps, replace a step's full action result with one line ("extracted 2,300 characters from X") before summarising anything | Biggest effect for long page runs; no model call needed (code only) | A later step may need an old result; keep the last N and anything marked `includeInMemory`; clear in batches to avoid changing the start of the prompt often |
| c. Give the summary model a smaller job | Summarise only what is older than 12 messages (already so) | none | |

**Recommendation: (b) then (a).** Built in issue #132: old long action results shrink to a line (`MessageManager.clearOldActionResults`, in batches, last 12 messages and short results kept) and compaction starts at 35% (`COMPACT_AT`), only when at least about 1,500 tokens would be summarised. Both are code in `threads/compaction.ts` and `agent/messages/service.ts`. Build on the existing `includeInMemory` flag on action results.

### 4.2 One front door, one recall

- **`remember`** takes a sentence and an optional `kind` (`fact`, `person`, `note`, `task`). Code routes it: a fact goes to the facts store, a person note to the people store, a page or long note to the KB, a to-do to the task board. The model never has to pick between four tools; the voice prose that explains the split (`voice/prompt.ts:20`) shrinks. Existing tools stay as aliases.
- **`recall`** searches facts, people, tasks, KB and workspace summaries in one call, scoped to the chat's workspace, and returns the top few with where each came from. This fixes "stored but never shown" without making the always-on block bigger.
- **Make the always-on block earn its place.** Keep the facts that are marked as most useful (name, role, company, active goals, the workspace's own facts) and let everything else be found with `recall`.

Not recommended: Anthropic's memory tool as a store. It is Anthropic-only, lets the model decide what to file and where, and has none of Ava's status, source or workspace fields. Its useful part, the model checking a memory folder before it starts, is what `recall` plus the always-on block already give.

### 4.3 Remember the right things per workspace

- Put one short **workspace card** (about 800 characters) at the top of every workspace chat: what it is, who matters, what is open. Source: the existing summary, refreshed when `workspace_context` runs, plus the workspace's own facts. It replaces the raw `about` text on every step when `about` is long.
- Facts already carry a `workspaceId` and other workspaces' facts are already filtered out and tested (see §3, item 6), so nothing to build there.

### 4.4 First steps, measurement, who builds

| Step | Ships alone | Measured by | Model |
|---|---|---|---|
| Clear old action results after about 5 steps; lower the compaction point to about 35% | yes | input tokens per finished run on a fixed set of 20 long tasks (from `usage/meter.ts`), and the success rate on the same tasks | sonnet |
| Test that shows which facts the prompt drops, and a `recall` over facts only | yes | share of stored facts that can be found; a script that asks 20 questions about stored facts | sonnet |
| `remember` front door with routing and aliases | after the above | share of facts that land in the right store on a labelled set of 30 sentences | opus (routing rules) |
| `recall` across all stores | after `remember` | answers about older facts, people and notes in a fixed question set | opus |
| Workspace card | after the above | tokens per step in workspace chats | sonnet |

## 5. What I could not confirm

- Anthropic's compaction numbers, and any independent test of the memory tool.
- Where workspace summaries are stored beyond "through the KB store" (`history/summaries.ts:26-31`).
- Whether any prompt includes the people store; I found none, but did not read every prompt builder.
- Real token counts of these blocks; sizes are characters from the caps, converted at 4 characters per token (the repo's own estimator uses 3, so up to a third higher).

## Sources

- Anthropic, [Managing context on the Claude Developer Platform](https://www.anthropic.com/news/context-management), 2025-09-29
- Anthropic docs (undated, read 2026-11-22): [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool), [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- Anthropic, [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp), 2025-11-04
- The Ava code at commit `4bdb8c1`, paths as cited above.

---

## Measured fixed prompt sizes (issue #130)

Note: these numbers come from the test in `src/background/prompt-budget` and replace estimates made from source text elsewhere in this file.


Real sizes from `src/background/prompt-budget` (run `pnpm test -t "size of what each channel sends"`; the test fails when a channel or a part grows by more than 10% against `baseline.json`, and `UPDATE_PROMPT_BUDGET=1` rewrites it). Tokens are characters divided by four. These replace the estimates above; page state and the conversation are not counted. Tool definitions are the JSON Schema of every action; the workspace row uses the longest "about" the app keeps (4,000 characters).

| Channel | Tool definitions | Rules, identity, channel, capability list | Workspace block | Total fixed |
|---|---:|---:|---:|---:|
| panel navigator | 53,197 ch (~13,300 tok) | 27,793 ch (~6,949 tok) | - | **80,990 ch (~20,248 tok)** |
| panel navigator, in a workspace | 53,197 ch (~13,300 tok) | 27,793 ch (~6,949 tok) | 4,773 ch (~1,194 tok) | **85,763 ch (~21,441 tok)** |
| whatsapp navigator | 53,197 ch (~13,300 tok) | 28,409 ch (~7,103 tok) | - | **81,606 ch (~20,402 tok)** |
| agent and routine chats | 53,197 ch (~13,300 tok) | 27,874 ch (~6,969 tok) | - | **81,071 ch (~20,268 tok)** |
| panel planner | 0 | 12,132 ch (~3,033 tok) | - | **12,132 ch (~3,033 tok)** |
| voice | 22,321 ch (~5,581 tok) | 6,103 ch (~1,526 tok) | - | **28,424 ch (~7,106 tok)** |
