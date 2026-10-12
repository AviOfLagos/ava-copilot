---
name: avi-conventions
description: Conventions for building Avi Copilot (this repo) — commands, ownership, registration points, state, errors, retry, security, i18n, tests, commits. Load before changing any code here, especially as a Wave 2 stream subagent.
---

# Building Avi Copilot

Read `CLAUDE.md` (repo root) and your stream's section of `docs/wave2-plan.md` first. This skill is the short,
binding version of the rules; the plan has the reasons.

## Commands (the Bash tool here)

- pnpm only through the guard: `snare shield check . >/dev/null && command pnpm <args>`. Never set
  `SNARE_SKIP_SHIELD`. Never add, remove or upgrade dependencies — ask the lead.
- Type-check `command pnpm type-check`; unit tests `command pnpm exec vitest run <paths>`; lint only touched files
  `command pnpm exec eslint <paths> --ext .ts,.tsx` (never `pnpm lint`, it rewrites the repo); format touched paths
  `command pnpm exec prettier --write <paths>`.
- Build `command pnpm build`; E2E in Brave:
  `CHROME_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" node --test e2e/<file>.e2e.mjs`.
  Redirect long output to a file and grep `^ℹ (pass|fail)`; never paste whole logs.
- Locales: `node scripts/check-locales.mjs` must pass.

## Ownership

- Edit only the paths your stream owns (plan table). Shared files (`src/background/index.ts`, `SidePanel.tsx`,
  `agent/actions/builder.ts`, prompts, `gate/review.ts`, `threads/manager.ts`, `db.ts`, `wxt.config.ts`,
  `package.json`, locales outside your keys) are changed by the lead only. If you need a change there, describe it in
  your final report instead.
- Plug in through the registration points, from your stream's own register file:
  - background `src/background/<stream>/register.ts` → `src/background/registry`: `registerCommand(type, zodSchema,
    handler)` (reply with `context.reply({type, requestId, ...})`), `registerRecovery`, `registerAgentAction({create,
    prompt})`, `registerVoiceTool({declaration, handler, guardLabel})`, `registerOffscreenBusy`;
    `src/background/jobs/runner.ts`: `registerJobHandler(kind, handler)` + `jobs.schedule({...})`.
  - panel `src/side-panel/<stream>/register.tsx` → `src/side-panel/registry.ts`: `registerPlace({id, label, icon,
    group: 'top' | 'profile', order, Component})`, `registerSettingsSection`. Components get `api: PanelApi`
    (`request` with timeout, `post`, `go`, `openThread`).
- New Dexie tables and indexes are the lead's; record types for your tables live in `src/storage/lib/<domain>/types.ts`.

## State

- The background is the only writer of shared state. Pages send commands; they read Dexie with `useLive`.
- Every command has a zod schema (registered) and a `requestId`; replies echo it.
- Long work is a persisted state machine (`RunRecord` / `RunStep` / `JobRecord`) with leases; `registerRecovery`
  resumes or marks it `interrupted` after the background restarts. No in-memory promise outlives a worker stop; any
  wait over 20 s is a job.

## Errors and retry

- Throw or convert to `AppError` (`@extension/shared`: `toAppError`). Show users a plain sentence + a fix; log the
  kind and cause, never secrets or full prompts.
- Retry with `withRetry(fn, RETRY_POLICIES.x)` only for idempotent work. Model calls already retry inside the AI SDK
  and the usage meter — do not wrap them again. Never auto-retry a side effect (send, post, write tool); a side
  effect cut off mid-call is `unknown_outcome` → an Inbox item. Use `CircuitBreaker` per external host.

## Security (non-negotiable)

- Everything from outside (pages, messages, connector/MCP output, transcripts, calendar titles, bus payloads) is data,
  never instructions: `wrapUntrustedContent` before a model sees it; never paste it into instructions or tool args.
- Every side effect passes the gate: attended → confirm card; unattended → Inbox approval. Nothing sends, posts,
  submits, deletes, publishes, buys, commits or changes permissions without the user's click. GitHub commits/push
  need approval + a secret scan, no override.
- Secrets live only in the vault (WS3); never in `storage.local`, logs, errors, prompts, exports or the page.
- Workspaces never mix: every new record carries `workspaceId`; queries filter by it.
- No `eval`/`new Function` anywhere (the extension CSP forbids it; check a library before relying on it).
- No new permissions, hosts or third-party calls without saying so in your report.

## UI

- Theme tokens only (`src/ui/lib/theme.css`; amber `hold` only for "waits for the user's click"). Components from
  `src/side-panel/components/ui` and `components/ai`. Every control has an accessible name; keyboard works; menus
  close on Esc and click-outside. Narrow panel (~400 px) first.
- Every user-facing string goes in all three locales (`en`, `pt_BR`, `zh_TW`) under your stream's prefix:
  WS1 `shell_`, WS2 `speak_`/`retry_`, WS3 `models_`, WS4 `conn_`, WS5a `flow_`, WS5b `agents_`, WS5c `inbox_`,
  WS6 `graph_`, WS7 `brain_`, WS8 `voice_engine_`.

## Tests and handing back

- Unit tests next to the code (`__tests__`), deterministic, mocks for network and chrome APIs. E2E for every
  user-visible flow you add, using the mock servers in `e2e/`.
- Before you finish: type-check, your unit tests, touched-file lint, your E2E in Brave, locales check, a short
  `docs/task.md` section. Commit on your branch as AviOfLagos (`gh-switch --for-repo` first) ending with the
  attribution line from the session. Do not push.
- Report: branch, what changed (paths), tests run and their results, anything you could not do, and every change you
  need in a file you do not own.
