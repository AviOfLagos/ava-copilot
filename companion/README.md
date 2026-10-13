# Nex Brain

Nex Copilot's companion on the Mac. It does what a browser extension cannot: runs code in a Docker sandbox per
agent, runs `gh` (reads, and posts only after a click), hosts local (stdio) MCP servers, runs routines while Brave is
closed, builds artifacts and shows them in an **Avi Studio** tab. The extension works fully without it; with it,
Settings › Nex Brain shows it connected.

Agent sessions run on **Vercel eve** (see [SPIKE.md](SPIKE.md) for why, with the evidence); everything else is
Nex Brain's own code. The extension only ever speaks one protocol: `src/shared/lib/protocol/companion.ts`.

```
Brave (extension) ──HTTP 127.0.0.1:47615, Bearer + Origin──▶ nex-brain (Node, this package)
                                                              ├─ pairing, rate limits, logs, health
                                                              ├─ sandbox: docker run per command, per agent profile
                                                              ├─ gh allowlist · stdio MCP · routines (croner + the
                                                              │  extension's workflow engine) · artifacts/Avi Studio
                                                              └─ eve start (random loopback port, per-boot secret)
                                                                 └─ agent/: one generic worker; model, instructions
                                                                    and tools come from nex-brain per profile
```

## Install

Needs Node 24+, and Docker Desktop (or OrbStack/Colima) for running code. Nothing else leaves the Mac.

```bash
cd companion
snare shield check . && pnpm install     # its own lockfile; 72-hour release-age rule in .npmrc
sh scripts/install-launchagent.sh        # builds, starts at login, prints a pairing code
```

Then in Nex Copilot: **Settings › Nex Brain**, type the port (47615) and the code, **Pair**. The token goes into the
extension's vault; the Mac keeps only its hash. `pnpm pair` prints a new code; `pnpm status` shows pairing and
Docker; `sh scripts/uninstall-launchagent.sh` removes the login item (data stays in
`~/Library/Application Support/Avi Brain`, unchanged so existing pairings and config are not lost). If Docker is not
running, health and every sandbox call say "Docker is not running. Start Docker Desktop, then try again.";
`pnpm sandbox:build` builds the sandbox image once.

| Command | What |
|---|---|
| `pnpm build` | bundle `dist/nex-brain.mjs` (its sources + the shared protocol + the extension's workflow engine) |
| `pnpm build:agent` | `eve build` of `agent/` (telemetry off) |
| `pnpm start` / `pair` / `status` / `sandbox:build` | the CLI |
| `pnpm test` | unit tests (vitest, no Docker, no network) |
| `pnpm test:eve` | end to end with the real eve: pairing, a session as a profile, an approved stdio-MCP call |
| `pnpm type-check` | tsc over `src/`, `agent/` and the shared extension files |

## Security model

- **Network:** listens on `127.0.0.1` only. Requests must name it in `Host` (no DNS rebinding).
- **Auth, fail-closed:** every `/v1` call needs the extension's `Origin`
  (`chrome-extension://fckijnclcihjnokahdnbogpbeiimfdio`, the pinned ID) **and** `Authorization: Bearer <token>`.
  The API is POST/PUT/DELETE only: the browser sends no `Origin` on an extension's GET. Pairing needs the origin
  and a one-time code (8 characters, 10 minutes, 5 tries, single use). A missing, unreadable or revoked token
  refuses. Per-route rate limits (pairing 5/min). A repeated `requestId` gets the first answer, never a second run.
- **Logs:** one JSON line per request (route name, status, ms); every string is redacted (tokens, keys, codes,
  view keys); no bodies.
- **Sandbox per agent profile:** `docker run --rm` per command with `--network none` (unless the profile says
  `open`), `--cpus`, `--memory` = swap, `--pids-limit 256`, `nofile 1024`, `--cap-drop ALL`,
  `no-new-privileges`, read-only root + 256 MB `/tmp`, user `1000:1000`, a time limit (then `docker kill`), and
  only the profile's workspace mounted. No variable of the Mac goes in. Image: `sandbox/Dockerfile`
  (`node:24-bookworm-slim` pinned by digest, Python 3, pnpm). The companion touches a workspace only while no
  container of that profile runs, and never follows a link in it.
- **Egress policy:** none by default. `open` is unrestricted egress for package installs; it can also reach
  services on the Mac's localhost through `host.docker.internal` (Nex Brain itself needs the token; Ollama does
  not), so agent profiles that need it are approved per command. Domain allowlists would need a filtering proxy
  (not built).
- **Host tools:** only `gh`, only `issue list/view/status`, `pr list/view/diff/checks/status`, `repo view`,
  `run list/view`, `release list/view`, `search issues/prs`; and with the user's click, `issue create`,
  `issue comment`, `pr comment` — after a secret scan, no override. No flag that reads a Mac file or opens a
  browser. Nothing that writes code (`git push`, `repo create`, `pr create/merge`, `api`) exists here.
- **stdio MCP:** configured only on the Mac (`<data>/mcp.json`, below); each server gets a safe environment plus
  its own `env`. Tools carry a sha256 fingerprint; a call naming an older fingerprint is refused. Only tools the
  user lists as `readOnlyTools` run without a click; a server's own `readOnlyHint` is never trusted.
- **Artifacts / Avi Studio:** frozen copies (regular files only, 300 files / 25 MB). Opening one mints a one-time
  token (2 min) that the extension puts in the Studio address's **fragment**; the Studio page trades it once (same
  origin only) for a view key (8 h) and wipes the address. Files are served read-only with
  `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; … connect-src 'none'; img-src 'self' data: blob:`:
  an opaque origin with no network, so an artifact cannot send anything anywhere or load a remote image.
- **Keys:** model keys stay in memory; a routine that must run after a restart with Brave closed can keep its key in
  the macOS Keychain, passed to `security -i` on standard input (never on a command line). Never on disk, never in
  eve's store, never in logs (`pnpm test:eve` checks the disk and the logs).
- **eve:** started with `EVE_TELEMETRY_DISABLED=1` (every eve command reports usage to Vercel otherwise), on a
  random loopback port, accepting only Nex Brain's per-boot secret and no browser `Origin`; `defaultTools: false`
  so a session has only its profile's tools; `modelContextWindowTokens` always given (no AI Gateway lookup); its
  store `.eve/` made 0700. Pinned to `eve@0.75.1`: a session can only resume on the eve version that started it.

### mcp.json

```json
{ "servers": { "notes": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"],
                          "env": {}, "readOnlyTools": ["read_file", "list_directory"] } } }
```

## Protocol (src/shared/lib/protocol/companion.ts)

| Call | Body → reply |
|---|---|
| `POST /v1/pair` | `{code, client}` → `{token, companionId, version, protocol}` (origin only, no token) |
| `POST /v1/health` | `{fresh?}` → version, Docker (state + what to do), engine, MCP servers, routines |
| `POST /v1/sandbox/run` | `{requestId, profileId, command, policy?, stdin?}` → `{exitCode, stdout, stderr, timedOut, truncated}` |
| `POST /v1/gh` | `{requestId, args, approved}` → `{exitCode, stdout, stderr}` |
| `POST /v1/tools/list`, `/v1/tools/call` | the companion as a connector (`CompanionToolSource`) |
| `POST /v1/sessions` | `{requestId, profile, model, message}` → `{sessionId}`; then `/:id/messages`, `/:id/answer` (approvals), `/:id/cancel`, `/:id/events` (`{cursor}` → NDJSON `SessionEvent`s; reconnect with `cursor = index + 1`) |
| `PUT /v1/workflows/:id`, `DELETE …`, `POST …/:id/run`, `/runs/answer`, `/sync`, `/sync/ack` | routines on the Mac |
| `POST /v1/artifacts`, `/v1/artifacts/list`, `/v1/artifacts/:id/open` | artifacts; `open` → the Studio URL |
| `GET /studio/:id`, `POST /studio/:id/session`, `GET /view/:id/:key/*` | Avi Studio (tab, no API token) |

Errors are `{ok:false, error:{kind, message, retryAfterMs?}}` with the `AppError` kinds and their HTTP statuses.

## Routines with Brave closed

The extension's engine (`src/background/workflows/engine.ts` with `spec.ts`, `template.ts`, `net.ts`, errors,
retry) is compiled into the companion by `pnpm build`, so states, retries, budgets, approvals and recovery are the
same. The Mac runs `trigger.schedule`, `trigger.manual`, `step.http_get` (public hosts only — names are resolved and
private addresses refused, no redirects), `step.llm` (any OpenAI-compatible endpoint), `step.condition`,
`step.sandbox`, and `out.inbox` / `out.brief_section` / `out.notify` (to an outbox). A routine with any other step
is refused. Schedules use the extension's 2-hour catch-up window.

What the extension sends and does (not wired yet; client methods exist in `src/background/companion/client.ts`):
1. `pushWorkflow({workflow: {id, name, version, workspaceId, agentId, status, spec}, model?, keepKey?, sandbox?})`
   when a routine marked to run on the Mac is created, changed, paused or resumed; `deleteWorkflow(id)` when deleted.
   `model` (with its key) only when the routine has `step.llm`; `keepKey: true` keeps the key in the Keychain.
2. On every health ping while online: `syncWorkflows(cursor)` → merge `runs[].run` / `runs[].steps` into
   `db.runs` / `db.runSteps`, apply the outbox (Inbox items via `postToInbox`, brief sections — sanitised — into the
   brief, notifications, and approvals as Inbox approvals answered with `answerWorkflowStep`), then
   `ackWorkflows(ids)`; keep the returned cursor.

## Tests

`pnpm test` (60 unit tests: pairing and fail-closed auth, Host/Origin/preflight, internal API, rate limits, gh
allowlist and secret scan, log redaction, sandbox arguments and limits, Docker down/missing/no image, timeouts,
links and paths, artifacts and Studio keys, MCP fingerprints and a real stdio server, eve event mapping on recorded
streams, sessions and the internal tool rules, routines with approvals, private-address refusal, schedules and
catch-up, Keychain over stdin). `pnpm test:eve` runs the real eve end to end. The extension's E2E
(`e2e/companion.e2e.mjs`) runs against `e2e/mock-companion.mjs`, which uses this same protocol file.

**Needs Docker to verify** (the engine was down while this was built): a real `docker run` with these flags
(especially the bind mount and uid 1000 writes on Docker Desktop's file sharing), `pnpm sandbox:build`, a
`step.sandbox` and an artifact build end to end.
