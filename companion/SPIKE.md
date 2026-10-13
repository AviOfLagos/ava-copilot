# Nex Brain spike: can Vercel eve run the companion's agent sessions?

Date: 2026-10-12. eve `0.75.1` (the newest version older than the 72-hour release-age rule; `0.77.0` is current),
`ai` `7.0.136`, `@ai-sdk/openai-compatible` `3.0.67`, Node 26.7, macOS arm64, Docker engine **down**.

## Verdict: build on eve (for agent sessions only)

The exit criteria were (a) a model chosen at runtime, (b) per-session instructions and tool allowlists, (f) a
fail-closed check on 127.0.0.1 with a bearer token and an Origin check. **All three hold, at runtime, not only on
paper**: `spike/eve-probe` builds a real eve agent with `eve build`, serves it with `eve start --host 127.0.0.1`, and
`node probe.mjs` passes **18 of 18** checks (`spike/eve-probe/probe-results.json`, raw streams in
`events-*.ndjson`).

eve therefore runs the **agent sessions** (model loop, durable turns, streaming with resume, approvals). Everything
else the companion does is outside what eve offers or does safely, and is Nex Brain's own code behind the same
protocol: the Docker sandbox per agent, the `gh` allowlist, stdio MCP, routines with Brave closed, artifacts and
Avi Studio, pairing and rate limits. The session engine sits behind an interface (`companion/src/sessions`), so the
fallback (AI SDK `ToolLoopAgent`) can replace eve without the extension noticing.

## Evidence, question by question

| | Question | Answer | Evidence |
|---|---|---|---|
| a | Model chosen at runtime (Ollama, LM Studio, OpenRouter, NVIDIA, any OpenAI-compatible) | **Yes**, through `defineDynamic` on `model` with a `step.started` handler returning a live AI SDK `LanguageModel`. `session.started`/`turn.started` may only return AI Gateway id strings, so non-Gateway models are resolved per step. Giving `modelContextWindowTokens` keeps eve from asking the AI Gateway catalog. | Probe: the session called `model-writer` on a local OpenAI-compatible server (`PASS a`). `docs/agent-config.md` "Choose the model dynamically". |
| b | Per-session instructions and tool allowlist, one generic agent | **Yes**, through the session's auth attributes (our auth function puts the profile id on the session), read by a dynamic instructions file and a dynamic tools file at `session.started`. With `defaultTools: false` the model sees **only** the profile's tools; without it eve adds `bash, read_file, write_file, web_fetch, load_skill, agent, task_wait, task_cancel` to every session (`web_fetch` runs on the host). `clientContext` is **not** a config channel: it becomes user-role messages the model reads. | Probe: writer saw `PROFILE-WRITER` and only `shout`; analyst saw `PROFILE-ANALYST` and only `add, danger` (`PASS b` ×3). |
| c | Sandbox isolation per session or per agent | **Per session only.** eve's Docker provider runs `docker run -d … --entrypoint /bin/sh <image> -c 'sleep …'` with **no** `--memory`, `--cpus`, `--pids-limit`, `--cap-drop`, `--read-only` or `--user`, network `allow-all` by default, base setup as root, image `ghcr.io/vercel/eve:<version>`. Sharing a sandbox across sessions needs a custom provider. When Docker is down the default falls back to microsandbox or just-bash (no process isolation, auto-installed during `eve dev`). | `dist/src/execution/sandbox/bindings/docker-container.js`, `docker-options.d.ts`; `docs/sandbox/*.mdx`. |
| d | Schedules created at runtime | **No.** Schedules are files found at build time; runtime schedules are a documented pattern (one `* * * * *` dispatcher plus your own store with leases). A schedule's session cannot wait for an approval: it fails. | `docs/schedules.mdx`, `docs/patterns/dynamic-scheduling.md`. |
| e | Approvals for a person | **Yes.** `approval: always()` parks the turn durably; the stream carries `input.requested` (`kind: 'tool-approval'`, `requestId`, the call); `POST /eve/v1/session/:id {inputResponses:[{requestId, optionId:'approve'}]}` resumes it. Caveat: a follow-up message whose text is `approve` also approves, so only Nex Brain may talk to eve. `auto()` sends the call to a decision model through the AI Gateway: never used. | Probe `PASS e` ×3 (approval → `approval.settled` → `action.result` → `turn.completed`). |
| f | Fail-closed auth on 127.0.0.1, bearer + Origin | **Yes.** A custom `AuthFn` gets the `Request`; eve refuses when every entry skips (401) and our function throws `ForbiddenError` (403) for a wrong origin. `eve start --host 127.0.0.1` binds loopback only (the default is all interfaces). Gaps: `GET /eve/v1/health` is public; eve's own channel cannot do per-route rate limits. So eve listens on a random loopback port with a per-boot internal secret, and only Nex Brain's own server faces the extension. | Probe `PASS f` ×5 (listener `127.0.0.1:<port>` only; 401 without/with a wrong token; 403 from another origin). |
| g | Stream resume | **Yes.** The NDJSON stream takes an absolute `startIndex`; events keep a stable `meta.id` across reconnects and rewinds. | Probe `PASS g` ×2. |
| h | Telemetry: nothing leaves the Mac | **Only with care.** Every eve CLI command, `eve start` included, sends a usage batch to `telemetry.vercel.com` by default (seen with `EVE_TELEMETRY_DEBUG=1`). With `EVE_TELEMETRY_DISABLED=1`, a given context window, no `auto()` approvals and no Gateway models, no connection left the machine during the probe. Runtime span export only runs inside Vercel's request context. | Probe `PASS h` (lsof of the server and its children every 250 ms). |
| i | Secrets never in durable session inputs | **Yes, if kept out of them.** eve keeps every event (messages, tool inputs and outputs, auth attributes, dynamic-tool closures) as plain JSON under `.eve/.workflow-data`, created **0755**. A key read from the environment or fetched at `step.started` is not stored; route tokens are not stored. So: keys are never in messages, profiles, closures or attributes, and the store directory is made 0700. | Probe `PASS i` ×2 (no token, no key in any file); `.workflow-data` mode 755. |

## What this means for the design

- **Two processes, one door.** `nex-brain` (Node, our code) binds `127.0.0.1:47615`, pairs, checks bearer + Origin
  on every API request, rate-limits per route, logs without secrets. It starts `eve start` on a random loopback port
  with `EVE_TELEMETRY_DISABLED=1`, a per-boot internal secret and `umask 077`, and proxies sessions to it.
- **The eve agent is thin.** `companion/agent`: `defaultTools: false`; model, instructions and tools are resolved
  from Nex Brain's internal API by the profile id on the session; every tool calls back into Nex Brain, which owns
  the policy (sandbox, `gh` allowlist, MCP read/approve, artifacts). Keys live in Nex Brain's memory (or the macOS
  Keychain for routines that run with Brave closed), never in eve's store.
- **Own sandbox, own scheduler.** Docker per agent profile with CPU, memory, pids and time limits, no network by
  default, non-root, read-only root; routines on croner with the extension's own workflow engine.
- **Pin eve exactly.** A session can only be replayed by the eve version that started it ("stranded" otherwise);
  eve shipped 18 versions in 10 days. Upgrades are deliberate, after the 72-hour rule.

## Re-run the probe

```bash
cd companion/spike/eve-probe
snare shield check . >/dev/null && command pnpm install --ignore-workspace
node probe.mjs        # builds, starts eve on 127.0.0.1, prints PASS/FAIL per check
```

No Docker and no network are needed (the model is a local mock); telemetry is disabled for every eve command.
