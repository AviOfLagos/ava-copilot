# Ava Keys

A local broker inside Ava Brain. Coding agents (Claude Code, Cursor, Codex, any MCP client) call it to get things
done that need Avi's secrets or Avi's hands: run a command with secrets, sign in, switch accounts, click through a
browser or desktop flow. The agent gets the result. It never gets a secret value.

Status: v0 ships `run_with_secrets` and `ask_human` (epic #52, v0 #53). Everything else here is
the plan.

## 1. Why

Today an agent that needs a key either reads a plain `.env` (the value lands in the cloud model's context and in
transcripts) or stops and asks Avi to do it (Avi is not technical, and each ask is a context switch). The offboard
vault already stores the values encrypted behind Touch ID (`offboard-vault run`). Ava Keys puts a door in front of
it that agents can open over MCP, with Avi's Touch ID as the lock and masking on the way out.

## 2. Threat model

**Who we defend against:** the cloud model and anything that reads its context (the provider, transcripts, logs,
a prompt injection in a web page or issue the agent read). The agent is treated as helpful but untrusted: it may
be tricked into asking for something Avi did not mean to allow.

**What the cloud model may see**

- Names: projects, envs, secret names (`DATABASE_URL`), account handles (`@avi`), site names.
- That a command ran, its exit code, and its output **after masking**.
- Whether Avi approved, denied, or did not answer.
- The steps Avi was asked to do and his button answer (`done`, `cant`, `timeout`).

**What it never sees**

- A secret value, in any tool result, error message, log line or notification.
- The vault key, the keychain item, cookies, session tokens, passwords, 2FA codes.
- Anything typed into a password field (Ava never asks Avi to type a secret into a dialog it shows).

**Where values exist, and for how long**

| Place | Holds values? | Notes |
|---|---|---|
| `~/.config/offboard/vault.db` | encrypted | AES-256-GCM, key in the login keychain, released only by Touch ID through the root-owned helper (offboard `docs/architecture.md`, "Vault threat model"). |
| The `offboard-vault` process | yes, briefly | Decrypts after approval, zeroes the key, starts the command. |
| The command's environment | yes, while it runs | `offboard-vault run` puts values only in the child's environment, never in a file. |
| Ava Keys' masker (`~/.ava-keys/mask`) | yes, while it runs | It is the child `offboard-vault` starts. It runs the real command, captures its output, replaces every value with `«NAME»`, and prints only the masked result. |
| Ava Brain's MCP server | **no** | It only ever reads masked text. It never decrypts and never sees the key. |
| The calling agent / cloud model | **no** | Gets masked text plus names. |

**Approval:** every use of a value is one Touch ID prompt, per call, no caching, no "allow for 5 minutes". There is
no flag, environment variable or tool argument that skips it (inherited from offboard: tests inject a fake
approver as a function argument, never through the environment).

**Residual risks, said plainly**

1. *The command itself.* A command started with secrets can do anything with them: send them over the network,
   write them to a file, print them in an encoding masking does not know. Masking protects the returned text from
   *accidents*; it does not make a hostile command safe. The defence is the prompt: it shows the exact command,
   and Avi denies what he does not recognise. Later: per-project allow-lists of commands (issue).
2. *Same-user tampering.* An agent with a shell can edit user-writable files, including `~/.ava-keys/mask` or a
   Homebrew binary the command uses. Ava Keys checks the masker's hash before each run (catches accidents and
   stale copies) but that is not a security boundary against a same-user attacker. Hardening: install the masker
   root-owned next to offboard's helper, run by offboard's root-owned node (issue).
3. *Social engineering of Avi.* An agent can ask for a reasonable-looking purpose. The prompt names the agent,
   the purpose, the account and the command so Avi can judge; `ask_human` dialogs never contain a text field.
4. Out of scope, as in offboard: same-user malware with unlimited time; a compromised macOS.

## 3. MCP tools

All tools take a `purpose` (one short sentence, shown to Avi) and return JSON text. Names only, never values.

| Tool | v | What it does | Returns |
|---|---|---|---|
| `run_with_secrets` | v0 | Run one command (argv, no shell) with the secrets of `project`/`env` in its environment, optionally `only` some names. Touch ID per call. | `{approved, exitCode, stdout, stderr, masked: {NAME: count}, unmasked: [names too short to mask], truncated, timedOut}` |
| `ask_human` | v0 | Show Avi numbered steps (dialog + notification now; Ava panel with on-screen pointers later) and wait for his answer. | `{answer: "done" \| "cant" \| "timeout", seconds}` |
| `list_secrets` | shipped (#54) | Projects, envs and secret names. No prompt (names only). | `{projects: {p: {env: [names]}}}` |
| `sign_in` | v1 | Make sure a site is signed in as an account in Ava's browser profile. Uses the vault for the password, the site adapter for the clicks, `ask_human` for 2FA or a CAPTCHA. | `{signedIn, account, steps}` |
| `switch_account` | v1 (gh, vercel shipped) | For a CLI (`gh`, `vercel`, `gcloud`) or a site: read the current account, switch to the named one, verify. Reuses `gh-switch`, `vercel-switch`, and the account check of issue #43. | `{from, to, verified}` |
| `do_action` | v2 | A named, deterministic action on a known site or app ("add env var on Vercel project X", "invite @y to the GitHub org") or, for an unknown screen, a goal handed to the local model. Each action declares the secrets it may use. | `{done, evidence, steps}` |
| `get_status` | shipped (#54) | Is Ava Brain up (its port answers), is the vault installed root-owned, is the masker on disk the current one, which agents have Ava Keys registered (Claude Code). | `{brainUp, vaultInstalled, maskerCurrent, agents: [{name, registered}]}` |

Arguments are validated before any prompt: project/env must exist, `only` names must exist, the command must
resolve to an absolute path, everything must fit the prompt (offboard refuses a reason over 200 characters or a
command over 150).

## 4. Approval flow

```
agent ──MCP──▶ Ava Brain (keys-mcp) ──spawn──▶ offboard-vault run --project P --env E --only A,B --
                                                  ~/.ava-keys/mask "claude-code: run db migration" /opt/homebrew/bin/pnpm db:migrate
                                                        │
                                       Touch ID prompt ◀┘  (offboard's signed, root-owned helper)
```

The prompt is offboard's own and cannot be skipped. Ava Keys puts the requester and purpose into the command
line so it shows up in it:

> **offboard vault** — requested by /usr/local/libexec/offboard/node …/offboard.mjs — Run with 2 secrets of
> project=go-solar-me env=local: "/Users/Apple/.ava-keys/mask" "claude-code: run db migration"
> "/opt/homebrew/bin/pnpm" "db:migrate"

So Avi reads: **who** (`claude-code`, from the MCP client's own name), **why** (the purpose), **which account**
(`go-solar-me`/`local`, and how many secrets), and **exactly what runs**. Denied or cancelled: the tool returns
`approved: false`, nothing ran.

Later (offboard change, tracked as an issue): a `--label` argument on `vault run` so the agent and purpose sit in
their own line of the prompt instead of in the command, and decryption inside the helper (offboard #14).

## 5. Output masking

Done by the masker, inside the process that already holds the values, so the values never cross into Ava Brain:

1. The masker treats every variable `offboard-vault` passed it as a secret, except the fixed non-secret ones
   offboard itself sets (`HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `PWD`, `LANG`, `LC_*`, `TERM*`, `TZ`, `CI`,
   `NO_COLOR`, `FORCE_COLOR`).
2. It runs the real command (absolute path, no shell, stdin closed, a time limit and an output cap), captures
   stdout and stderr in full, then replaces, longest value first: the raw value; its base64 (standard and URL-safe,
   with and without padding); its URL-encoding; its JSON-escaped form; its hex. Each becomes `«NAME»`.
3. Values shorter than 4 characters are not masked (they would shred the output); their names are returned in
   `unmasked` so the agent knows.
4. It prints one JSON object with the masked text and per-name counts. Ava Brain then runs the same secret-pattern
   scan used before GitHub writes (`security/secrets.ts`) as a second net and replaces any hit with
   `«redacted: kind»`.

## 6. Adapters versus a local model

- **Known sites and apps get deterministic adapters**: Vercel, GitHub, Google, Supabase, Resend, AWS console, Figma,
  Slack, and Ava's own playbooks. An adapter is code: URLs, selectors, the expected account check, and a verify
  step. It reuses offboard's Playwright adapters (`browser/`, `services.json`) and its dedicated Brave profile
  (`~/.config/offboard/browser/profile`). An adapter run is repeatable, testable and cheap.
- **Unknown screens go to a local model**, never the cloud model, because the screen may show secrets. Ollama on
  the Mac (`qwen3:4b` class for text, a small vision model for screenshots) reads the screen and proposes the next
  click; Ava Keys executes it. The cloud agent only gets the outcome.
- **When neither works, `ask_human`.** The adapter or the local model writes the steps; Avi does them.
- Every adapter step that needs a value types it straight from the vault into the field; the value never passes
  through any model.

## 7. `ask_human` step format

```json
{
  "purpose": "Approve the GitHub device login",
  "steps": [
    { "text": "Open the Brave window that says GitHub", "target": "window:Brave — GitHub" },
    { "text": "Click the green Continue button", "target": "css:button[type=submit]" },
    { "text": "Type the code 8F3K-29QL and press Enter" }
  ],
  "timeout_seconds": 600
}
```

- Steps are numbered, one action each, plain words, at most 10 steps, 140 characters a step.
- `target` (optional) is what the pointer points at: a CSS selector in Ava's browser, an accessibility path or
  screen rectangle on the desktop. v0 ignores it and shows the text only.
- v0: a macOS notification plus a dialog with the numbered steps and two buttons, **Done** and **I can't**. No text
  field, ever: Ava never asks Avi to type a secret into something an agent wrote.
- Later in the Ava panel and the desktop app: the steps as a checklist, and for each step a numbered pointer drawn
  on the screen over the thing to click (an always-on-top transparent window in Electron; an overlay in the browser
  tab through the extension). Ava watches the screen and ticks steps off itself when it can.
- 2FA codes, CAPTCHAs and payments are always `ask_human`; Ava never does them.

## 8. One-command install

```
ava-brain keys install
```

1. Writes the masker to `~/.ava-keys/mask` (mode 0500, `#!` to this node) and records its hash.
2. Checks `offboard-vault` is installed root-owned; if not, prints the one offboard step to run.
3. Registers the MCP server with every agent it finds, idempotently:
   - Claude Code: `claude mcp add --scope user ava-keys -- <node> <ava-brain> keys-mcp`
   - Cursor: merges an `ava-keys` entry into `~/.cursor/mcp.json`.
   - Codex, Windsurf and others: their config file, same shape (follow-up issue).
4. Prints what it registered and how to remove it (`ava-brain keys uninstall`).

v0 ships Claude Code registration; the others are issues.

## 9. In the Electron desktop app

The team plan (§6) makes Ava Brain the core of an Electron app, the React panel its window, and the extension the
browser's hands. Ava Keys fits without moving:

- The MCP server stays a stdio command (`ava-brain keys-mcp`), so agents keep working whether the app window is
  open or not. When the app is running, the server forwards `ask_human` and progress to it over the existing local
  channel; when it is not, it falls back to the dialog.
- The app's window gets a **Keys** view: pending requests, live approvals, an activity log (names only, from
  offboard's vault log plus Ava Keys' own), registered agents with an off switch each.
- The on-screen pointers for `ask_human` and the desktop half of `do_action` use the app's computer-use layer
  (§6 candidates: trycua/cua, UI-TARS-desktop), driven by the local model.
- Touch ID stays offboard's root-owned helper. The app never holds the vault key; signing the app does not change
  that.

## 10. Build order

1. **v0** (this PR): `run_with_secrets`, `ask_human` (dialog), `ava-brain keys-mcp`, `ava-brain keys install` for
   Claude Code. Tests.
2. `list_secrets`, `get_status`; Cursor and Codex registration; `keys uninstall`.
3. `switch_account` for `gh` and `vercel` (wraps `gh-switch`, `vercel-switch`; shipped), then sites, sharing #43's check.
   No Touch ID (no secret value is used; agents already run these scripts), but Avi gets a notification on every change.
   It refuses to switch Vercel away from an unsaved login (that login would be lost) and does nothing when already on
   the account asked for.
4. `ask_human` in the Ava panel with pointers.
5. `sign_in` through offboard's browser profile and adapters.
6. `do_action` with deterministic adapters; local-model fallback for unknown screens.
7. Hardening: root-owned masker; offboard `--label`; per-project command allow-lists; decrypt in helper (offboard #14).
