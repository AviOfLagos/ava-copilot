# Is Ava aware of all her tools, everywhere?

Research, written 2026-11-22. No code was changed. Related: [code-mode.md](code-mode.md) (token measurements and method), [memory.md](memory.md).

## Summary for the owner

1. **Short answer: mostly, but not by design.** Ava has a "what I can do" list built from what is installed, and the voice assistant, the panel chat and the planner all read it. But it is built from the *voice* tools, so the chat is told about things only the voice can do.
2. **WhatsApp is the weakest channel.** It runs the same chat agent as the panel, with the same 85 actions and no filter. It cannot read the calendar, the inbox or the brief (those tools exist only in voice), yet it carries tools that make no sense from a phone.
3. **Nothing forces new tools into the list.** A test checks that every voice tool has a group. No test checks the chat actions, and an action that fails to build for the list is silently dropped.
4. **Recommendation.** One catalogue of tools, each with a plain-language name and a rule per channel (panel, voice, WhatsApp, agents, routines). Each channel's tool list and its "what I can do" answer are generated from it.
5. **Smallest first step.** A generated table of every tool and the channels that can use it, plus a test that fails when a tool has no row. No behaviour changes.

---

## 1. How Ava learns what she can do today

- **The catalogue.** `currentCapabilities()` (`src/background/capabilities/sources.ts:22-33`) gathers every voice tool (the 19 fixed ones and the registered ones), every chat action (built-in and registered), the side-panel places and the settings sections. `buildCapabilities` (`capabilities/catalog.ts`) puts the voice tools into groups using a hand-kept map, `TOOL_GROUPS` (`catalog.ts:73-139`, 64 entries); a tool with no entry goes under "More".
- **Who reads it.**
  - Voice: the start of each conversation (`voice/manager.ts:742-746`) and the tool `what_can_you_do` (`capabilities/register.ts:230-236`).
  - Planner: `buildAbilitiesSection` (`agent/prompts/channel.ts:44-66`), passed in at `threads/factory.ts:154`. It tells the planner to answer "can you…?" at once from this list and "never claim something that is in neither list".
  - Navigator: the same compact list, added to its rules by the `what_can_you_do` registration (`capabilities/register.ts:396-413`).
  - Chat: the action `what_can_you_do` returns the full list (`capabilities/register.ts:373, 412`).
- **How tools get in.** Two registries in `src/background/registry/index.ts`: `registerAgentAction` (`:106`) and `registerVoiceTool` (`:159`). A feature registers each separately; 33 names are in both.
- **Quiet-failure path.** The list of chat actions is built from a stand-in context, and an action that throws is "left out rather than failing the list" (`registry/index.ts:114-129`).

What the tools look like to each channel: see the per-channel table in code-mode.md §2.3. In short, **there is no per-channel tool filter**. Every chat origin (panel, WhatsApp, agent, routine, brief) gets all chat actions (`agent/actions/builder.ts:780`, `agent/executor.ts:128`); the origin only changes one paragraph of text (`threads/factory.ts:192-194`, `agent/prompts/channel.ts:19-27`).

## 2. The gaps, by channel

Counts come from a source-text scan (method in code-mode.md §2.1): 85 chat actions (25 built in, 60 registered), 64 voice tools, 31 tools that exist only in voice, and 29 registered chat actions that have no voice tool.

### 2.1 WhatsApp (a chat with origin `whatsapp`)

| # | Gap | Where |
|---|---|---|
| W1 | **Cannot see** the calendar, brief, inbox or workspace list: `get_schedule`, `get_brief`, `read_inbox`, `manage_inbox`, `list_workspaces`, `list_connectors`, `list_personalities`, `ask_meeting`, `start_meeting_notes`, `stop_meeting_notes`, `join_next_meeting` exist only as voice tools (`voice/prompt.ts:130-135`, `inbox/voice.ts:29`, voice tools in `capabilities/register.ts`). The brief is pushed to WhatsApp (`whatsapp-remote/bridge.ts:629-630`) but cannot be asked for. | no chat action of these names |
| W2 | **Told it can, but cannot.** The planner's "what you can do" lists voice tool names (`channel.ts:63`, fed by `sources.ts:22-33`). Asked "can you read my calendar?" from WhatsApp, the planner is told to answer from that list. This is a risk, not a failure I observed. | `channel.ts:44-66` |
| W3 | **Sent but of no use from a phone.** `open_place` (opens a panel page on the computer), `check_audio`, `check_model`, `say_in_meeting`, `set_personality` are in the list of every chat. The channel text already says the user "cannot see your browser tab or click anything in the side panel" (`channel.ts:22-24`). | `capabilities/register.ts:379-385`, `meet-voice/register.ts:384` |
| W4 | **Growth-team and product tools on every message** (15 actions, about 10k characters, `growth-team/*`, `growth/*`). They guard themselves when no workspace or product is set (`growth-team/actions.ts:85-96`) but are still sent. | |
| W5 | **Ones that need a click wait in the panel**, and the user is told (`channel.ts:22-24`). This works; the question is whether the model should be offered a tool whose only result is "wait for a click at the computer". | |
| W6 | **Commands read in code, not by a model** (delete that, react, tasks): good, cost zero, and invisible to the catalogue. "What can I say on WhatsApp?" has no generated answer. | `whatsapp-remote/commands.ts`, `task-commands.ts` |

### 2.2 Panel chat

| # | Gap | Where |
|---|---|---|
| P1 | Same as W2: the abilities section lists voice names the chat cannot call. 31 names. | `channel.ts:63` |
| P2 | The capability list is in two prompts (planner and navigator), so it is paid for twice per planning round. | `channel.ts:44-66`, `capabilities/register.ts:396-413` |
| P3 | Connector tools past the 6,000-character list limit are not listed; "a tool's exact name still works", but the model cannot know the name. | `integrations/catalogue.ts:14-16, 77` |

### 2.3 Voice

| # | Gap | Where |
|---|---|---|
| V1 | Does not know chat-only tools by name (29), e.g. `drive_create_doc`, `drive_share`, `call_tool`, `update_agent`, growth-team actions, `whatsapp_*`. It is told to use `do_task` for "connectors, WhatsApp drafts, agents to create, skills, forms" (`voice/prompt.ts:6-29`). That is awareness by category, and it costs a whole chat run per hop. The full list reaches voice only if the user asks (`what_can_you_do`). | `voice/prompt.ts`, `capabilities/register.ts:236` |
| V2 | The prose of the voice instructions names 39 tools by hand. I checked: none of the names is stale (0 of the names in the prose are missing from the code). 25 declared voice tools are not named in the prose (they are known through their declarations and the grouped list). Good now; nothing keeps it so. | `voice/prompt.ts:6-29` |
| V3 | The group map is hand-kept; the test covers voice tools only (`capabilities/__tests__/catalog.test.ts:72`). | `catalog.ts:73` |

### 2.4 Agents and routines

| # | Gap | Where |
|---|---|---|
| A1 | Chats started by an agent or routine (`origin` `agent`/`workflow`) get all 85 actions, though no one is waiting live (`channel.ts:17-18`). `open_place`, `check_audio` and the like make no sense there. | `agent/prompts/channel.ts:17` |
| A2 | Routine authoring sees only the connector tools listed with the request and the step vocabulary (`workflows/authoring.ts:75`, `workflows/spec.ts:105-165`). Ava's own tools (tasks, people, metrics) are reachable only through `step.agent`, which starts a whole chat. A routine author, human or model, cannot be told "you can use task_list here". | |
| A3 | Routine steps on Ava Brain (`step.llm`) get no tools by design (`companion/src/workflows/executors.ts`). Correct, but not stated anywhere a user can read. | |

### 2.5 Ava Brain (the Mac app)

It has its own sandbox for agents (Docker, no network by default, `companion/src/sandbox/docker.ts`), WhatsApp, calendar and the vault. None of these appear in the catalogue; the chat prompt describes Ava Brain only as prose (`channel.ts:34`).

### 2.6 Across channels

- **No single list.** Tools are defined in about 28 files across 23 folders and listed again by hand in `TOOL_GROUPS`, in the voice prose and in per-feature prompt strings (about 26 of them are added to the navigator's rules: `registry/index.ts:131-135`).
- **No rule per channel in code.** The WhatsApp paragraph says what the user cannot do; nothing removes the tools that depend on it.
- **Nothing counts.** Nobody can see how many tools a channel sends, or when a new one raises the cost for every channel (see code-mode.md, issue 1).

## 3. Proposal: one catalogue

### 3.1 The design

Each tool is described once, in one record:

```ts
type ToolSpec = {
  id: string;                    // 'task_add'
  title: string;                 // plain words for a person: "Add a task"
  does: string;                  // one sentence: what it does, in plain words
  group: 'tasks' | 'people' | 'calendar' | ...;
  effect: 'read' | 'write' | 'send' | 'delete' | 'spend' | 'share';  // the gate's words
  needsScreen: boolean;          // only makes sense with the user at the computer
  channels: Record<'panel' | 'voice' | 'whatsapp' | 'agent' | 'routine',
                   'direct' | 'hand-over' | 'never'>;
  schema: ZodType;               // arguments
  run: (args, context) => Promise<Result>;
};
```

From this one list, the code generates:
1. **Each channel's tool list.** The chat agent's actions and the voice declarations are made by a function `toolsFor(channel)`.
2. **Each channel's "what I can do" text.** Plain-language titles grouped by `group`, with an honest "I can do this, but at the computer" line for `needsScreen` tools on a phone. No tool names for people; names for the model.
3. **The routine builder's vocabulary** (so a routine can name any tool the routine channel allows).
4. **A tests table.** For every tool: which channels, how many tokens, which tests mention it.

`hand-over` means the channel does not carry the tool but knows it exists and passes the request on (what voice does today with `do_task`). That keeps the question "can you…?" answered truthfully with no tokens spent on the definition.

### 3.2 Rules per channel (first version)

| Channel | Rule | Examples removed |
|---|---|---|
| Panel chat | Everything that makes sense in a chat | `say_in_meeting` (it speaks into a live call) |
| WhatsApp | Everything that works with the user away from the computer. Tools that change something still ask first, the card waits in the panel and the user is told. Plus the read tools now missing (calendar, brief, inbox, workspaces). Nothing that only makes sense with the screen. | `open_place`, `check_audio`, `check_model`, `say_in_meeting`, `set_personality` (open question). Voice-only tools such as `switch_model` and the call controls are not in chats at all. |
| Voice | Tools a spoken turn can use, plus `do_task` as hand-over for the rest | page-reading and growth-team tools stay hand-over |
| Agents and routines | Everything that can finish unattended; gated ones go to the Inbox as today | `open_place`, `check_*`, `ask the user` style tools |

"Nothing that needs a click on WhatsApp" has two readings: (1) hide any tool that can ask for a click, which would remove most useful tools since every send, post or delete asks; (2) hide tools that need *a person at the screen to make sense*. I recommend (2). The gate still decides each effect, and what waits for a click is queued as it is now.

### 3.3 Options

| Option | What | Pros | Cons |
|---|---|---|---|
| 1. Generated table and a test only | Scan both registries, write `docs/tools.md`, fail when a tool is not in the table | Zero behaviour change, ships in a day | Does not fix W1-W4 |
| 2. Metadata on the existing two registries | Add `channels`, `title`, `needsScreen` as optional fields to `registerAgentAction` and `registerVoiceTool`; filter in `registeredActions()`; generate the lists from them | Small diffs; keeps upstream merges easy (this repo is a fork) | Two records for one tool stay two records |
| 3. One `registerTool` replacing both | The full design above | Cleanest | Touches 28 files; larger, riskier |

**Recommendation: 1, then 2, then 3 only if 2 shows duplication hurting.** Steps are separate pull requests.

### 3.4 Smallest first step, how to measure, who builds

| Step | Ships alone | Measured by | Model |
|---|---|---|---|
| A generated table of all tools (name, groups, channels, characters) and a test that fails when a tool is missing from it or from `TOOL_GROUPS` (chat actions too) | yes | the test; the table's tool count per channel | sonnet |
| Channel filter: a short deny-list per channel, applied in `registeredActions()` and the voice tool list | yes | tools sent per channel; no change in a fixed set of 20 tasks that must still pass | sonnet |
| Add the missing read tools to chats (calendar, brief, inbox, workspaces), reusing the voice tools' handlers | yes | "what's on my calendar?" answered on WhatsApp in a scripted test | sonnet |
| Generate the planner's "what you can do" and the navigator's list from the catalogue per channel, so a chat never lists what it cannot call | after the filter | a test set of 30 "can you…?" questions per channel, checked against the catalogue | opus (prompt design and judging) |
| `ToolSpec` with plain-language titles; `what_can_you_do` answers in plain words per channel | after the above | the same question set; plain-language check by the owner | opus for the design, sonnet for the migration |

## 4. What I could not confirm

- Counts of tools are from a text scan, not from running the code (the run was refused; see code-mode.md §2.1). A tool defined through a helper in a way the scan misses would be absent. Issue 1 replaces the scan with a real count.
- I did not trace every reader of the people and task stores at prompt time.
- I have not seen what the planner actually answers to "can you read my calendar?" on WhatsApp. W2 and P1 are reasoned from the prompt text.

## Sources

All from the repository at commit `4bdb8c1` (branch `feat/restyle`, 2026-11-22). External sources are in [code-mode.md](code-mode.md).
