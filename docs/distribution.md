# Distribution

How Avi Copilot gets onto someone else's machine, today and next. `docs/task.md` section 6 originally assumed
"sideloaded only, no Chrome Web Store submission" — this doc revisits that now that the ask is to make the
extension installable by other people, not just the owner.

## Today's path: install script + one "Load unpacked"

Chrome, Brave and Edge all refuse to install an extension from outside their store without Developer Mode, except
through an enterprise policy nobody here has. So there is no literal one-command install today — the honest version
is: **one command does everything a command can do, then one click finishes it.**

```bash
curl -fsSL https://avi-copilot.vercel.app/install.sh | bash
```

What that command does (`site/public/install.sh`, built by `scripts/release.mjs`):

1. Reads `download/latest.json` from the site, downloads `download/avi-copilot-<version>.zip`, verifies its
   SHA-256.
2. Unpacks it to a stable, versionless folder — `~/Library/Application Support/Avi Copilot/extension` on macOS,
   `${XDG_DATA_HOME:-~/.local/share}/avi-copilot/extension` on Linux — so re-running the same command later is an
   **update**, not a reinstall: the browser's "Load unpacked" always points at the same path.
3. Finds installed Brave/Chrome/Edge/Chromium, copies the folder path to the clipboard if it can, and opens the
   browser's extensions page if the browser accepts a URL on its command line (confirmed on this machine: `open -a
   "Brave Browser" "brave://extensions"` opens it, in a new tab if Brave is already running).
4. Prints the three remaining clicks: enable Developer Mode, click "Load unpacked", paste the path.

Re-running the command is how updates work for now: no silent auto-update exists outside a store. `--uninstall`
removes the folder; `--with-voices` optionally fetches the local voice and wake-word models (see below). Windows
gets `site/public/install.ps1` — written but **untested** on a real Windows machine; see its header.

This path needs no account, no money, and no review. It is the only path that works today, and it is enough to
call the extension "installable by other people with one command" — the Chrome Web Store section below is what
turns the second step (the one click) into zero clicks.

## Chrome Web Store (a true one-click install)

### What it needs

| Item | Detail |
|---|---|
| Developer account | A Google account registered at the Chrome Web Store Developer Dashboard, one-time **$5 USD** registration fee. **Needs the owner**: an account and a card. |
| Privacy policy URL | The site's `/privacy` route (`site/docs/ARCHITECTURE.md` already plans it: what it stores, what leaves, what never does, permissions explained). Must be live at a public URL before submission. |
| Listing assets | Short + detailed description, at least one 1280×800 or 640×400 screenshot, a 128×128 icon (have it: `public/icon-128.png`). No promotional screenshots exist yet — **needs the owner** (design, or screenshots of the real app). |
| Permission justifications | One sentence per sensitive permission, in the dashboard's Privacy Practices tab. Table below; `site/src/content/site.ts`'s planned `permissions (name, why)` field for `/privacy` should read from the same table, so the two never drift apart. |
| Single purpose description | CWS requires one sentence saying what the extension does, used to check every permission is actually needed for that one purpose. Draft: "Avi Copilot is a browser copilot that reads and acts on the pages you direct it to, with your click required before anything it does leaves your control." |

### Permission justifications

| Permission | Why it's requested | Review note |
|---|---|---|
| `storage`, `unlimitedStorage` | Chats, meeting notes, the knowledge base, workspaces and settings are saved locally in the browser; the default quota is too small for meeting transcripts and the knowledge index. | Low risk. |
| `scripting`, `activeTab` | Injects the content script that reads page content and dispatches the actions the agent decides on (click, type, extract) in the tab the user is working in. | Low-medium; standard for any page-automation extension. |
| `tabs`, `tabGroups` | Lists and switches tabs so the agent can find or open the right one mid-task, and groups the tabs a multi-step task opens so they're not lost among the rest of the window. | Low-medium. |
| `webNavigation` | Knows when a navigation finished (including SPA route changes that `scripting` alone can't detect reliably) before the next action runs. | Low. |
| `host_permissions: <all_urls>` | The core feature: the user can direct the agent at any site. This is the permission CWS scrutinizes hardest for automation extensions — the justification has to tie it to that one purpose, not claim it defensively. | **High.** CWS's "broad host permissions" review guidance applies in full; expect the slowest part of review to be here. |
| `debugger` | Drives the page over the Chrome DevTools Protocol (`puppeteer-core` in `src/background/browser/page.ts`) for input dispatch and screenshots that `scripting` cannot do reliably. Chrome shows a persistent "is debugging this browser" bar on every tab it attaches to while a task runs — users see this, and `docs/task.md` already logs it as expected behavior, not a bug. | **Highest.** `debugger` is the permission CWS reviewers reject automation extensions over most often; be ready to explain in detail and expect multiple review rounds. The infobar is also a real first-run surprise worth calling out on the site, not just in the store listing. |
| `tabCapture` | Records a meeting's own tab audio for notes — only the tab the user invoked the extension on, never an arbitrary tab (`src/background/meetings/manager.ts`). | Medium; tie the justification to "meeting notes," not "audio capture" in general. |
| `offscreen` | Hosts the offscreen document that does audio capture, local transcription and local text-to-speech — APIs a Manifest V3 service worker cannot run directly. | Low; implementation detail, but reviewers ask what runs in it. |
| `identity` | `chrome.identity.launchWebAuthFlow` signs the user into connectors (MCP servers: Notion, Slack, Google, etc.) via OAuth, through the browser's own sign-in window — no password ever touches the extension. | Medium. |
| `topSites` | When voice is asked for "my email" or "my social media," looks at the user's most-visited sites to guess which account (`src/background/voice/browser-tools.ts`). | Medium; CWS treats `topSites` as sensitive browsing-history-adjacent data — justify narrowly ("disambiguating a voice command"), not as analytics. |
| `alarms` | Schedules meeting reminders, the wake-word listener's own timers, and periodic jobs (morning brief, calendar watcher). | Low. |
| `notifications` | Surfaces meeting reminders, autojoin prompts, and Inbox items waiting for approval. | Low. |
| `tts` | Reads answers aloud with Chrome's built-in voices, alongside the local on-device voices. | Low. |
| `content_security_policy: 'wasm-unsafe-eval'` | Not a permission, but reviewed similarly: required to run the on-device "Hey Ava" WebAssembly recognizer. Nothing else in the CSP allows eval or remote code. | Medium; reviewers do check CSP relaxations. |

### The manifest `key`, OAuth redirect URIs, and the companion's origin check

`wxt.config.ts` embeds a public key that pins the extension ID to `fckijnclcihjnokahdnbogpbeiimfdio` for **every**
unpacked install, anywhere, so two things that are hardcoded to that one ID keep working: the OAuth redirect URI
registered with each connector's provider (`https://fckijnclcihjnokahdnbogpbeiimfdio.chromiumapp.org/`,
`src/background/integrations/oauth.ts`), and the Mac companion's origin check
(`COMPANION_EXTENSION_ID` in `src/shared/lib/protocol/companion.ts`, checked against
`chrome-extension://fckijnclcihjnokahdnbogpbeiimfdio` on every request).

Chrome Web Store assigns its own extension ID to a new listing — **except** that migrating an extension from
sideloaded/self-hosted distribution to the store while keeping the same ID (so existing users' local storage isn't
orphaned) is a documented, supported path, and it works by **keeping `key` in the manifest you upload**: the store
honors it on first publish instead of generating a new one. That is the right outcome here and the recommended
default — keep `key` in the Store build too, not just the sideloaded one.

This is the one real uncertainty in this whole plan, because it can only be confirmed by an actual upload to the
dashboard (needs the owner's account):

- **If the Store honors `key`** (expected): the published ID is also `fckijnclcihjnokahdnbogpbeiimfdio`. Nothing
  else in this section changes.
- **If it doesn't**: the Store assigns a new ID. The redirect URI problem is minor — every OAuth provider used here
  supports registering more than one redirect URI per client, so add the new `https://<new-id>.chromiumapp.org/`
  alongside the existing one rather than issuing a second OAuth client. The companion side needs a small, real code
  change: turn `COMPANION_EXTENSION_ID` (one constant) into a short allowlist of trusted IDs, checked the same way.
  Not done now — this doc is the plan, not the change; implement it only once a real Store ID is known, if it
  differs.

Either way: **never remove `key` from the sideloaded build.** It is what makes "Load unpacked" give the same ID on
every machine; without it, the ID is derived from the install path and would be different for every single person
who runs the install script, breaking OAuth and the companion for all of them, not just in some edge case.

### Review risks, roughly in order

1. **`debugger` + `<all_urls>` together.** This combination is what separates "a popup extension" from "something
   that can read and act on everything you do in the browser." Expect the longest review time here, possibly more
   than one rejection-and-resubmit round. Being ready to answer "why debugger and not just scripting" in detail,
   before submitting, saves a round trip.
2. **`topSites`.** Looks adjacent to browsing-history harvesting if the justification is vague. The voice
   disambiguation use case is narrow and should be stated narrowly.
3. **The debugger infobar as a user-trust problem, not just a review problem.** Chrome shows "Avi Copilot is
   debugging this browser" on every tab it attaches to. First-time users who weren't expecting it will be alarmed.
   The site should say this plainly before install, not let it be a surprise (`docs/task.md` section 5 already
   calls this "expected behaviour that needs a clear message, not a bug to fix" for the product itself; the same
   applies to the marketing copy).
4. **Remote code / eval policy.** `wasm-unsafe-eval` is for one on-device WebAssembly model and nothing else; the
   build has no `eval`, no `new Function`, no remotely fetched code (`scripts/wake-word-setup.mjs` explicitly
   strips `eval`/`new Function` out of the vendored recognizer at build time, and checks that it did). Worth stating
   this proactively in the submission notes rather than waiting for a reviewer to ask.
5. **Minimum permissions.** Several permissions (`tabGroups`, `topSites`) are for secondary features. CWS reviewers
   sometimes ask to see each one's feature live; having the relevant setting or command ready to demo shortens
   review.

### Package size with bundled models

Measured from a real build (`node scripts/release.mjs`, version 0.2.0): **`dist/` is 63.2 MB unpacked, the zip is
16.9 MB.** That's with zero voice or wake-word models bundled — the size is almost entirely two ONNX Runtime
WebAssembly binaries (`ort-wasm-simd-threaded.{asyncify,jsep}.wasm`, ~27 MB and ~28 MB) that `@huggingface/transformers`
pulls in as a normal bundled dependency for local inference. These compress well (55 MB of WASM becomes most of
that 16.9 MB zip) and can't be made git-ignored or optional the way the voice/wake *model weights* are, because
they're the inference runtime itself, loaded unconditionally by code the bundler can see is reachable.

The actual voice/wake model **weights** (`public/wake/`, `public/voice/`, ~70 MB together, from
`scripts/wake-word-setup.mjs` and `scripts/voice-models-setup.mjs`) are git-ignored and never enter the zip at all:
`scripts/release.mjs` builds from a clean `git worktree`, which only ever contains tracked files, so they can't end
up in `dist/` by accident. The Store submission is the same `dist/` the install script ships — 16.9 MB, voice
features inert until the user opts in (in-app, or `install.sh --with-voices`, which fetches them directly from
their pinned sources afterward). Chrome Web Store has no hard package size limit this project comes close to
either way; keeping the model weights out of the base package is about install speed for everyone who doesn't use
voice, not a store limit.

## Edge Add-ons

Microsoft Edge can install extensions directly from the Chrome Web Store (it prompts to allow "extensions from
other stores" the first time). **Publishing to the Chrome Web Store therefore already reaches most Edge users** —
a separate Edge Add-ons listing is a nice-to-have for discoverability inside Edge's own store UI, not a
requirement. Microsoft's Partner Center registration for Edge Add-ons has historically had no separate fee (unlike
Chrome's $5); confirm current terms at submission time. The listing assets (description, screenshots, privacy
policy URL) are the same as the Chrome Web Store's, so this is cheap to do once the Chrome listing exists, and
should come after it rather than in parallel.

## Windows

The install script is POSIX `sh`, so it doesn't run on Windows outside WSL or Git Bash. `site/public/install.ps1`
is a PowerShell equivalent — same shape (download, verify SHA-256, unpack to a stable per-user folder, print the
"Load unpacked" steps) — written but genuinely **untested**: there is no Windows machine in this environment to run
it on. Treat it as a draft until someone runs it for real; its own header says so. It does not implement
`--with-voices`: the model setup scripts shell out to `tar` and `unzip`, and `unzip` isn't a default part of
Windows. There is no real fallback for a non-developer on Windows today — `Settings › Voice engines`
(`src/side-panel/voice-engines/command.ts`) only ever prints a `node scripts/voice-models-setup.mjs` command,
which needs a repo checkout and a rebuild to take effect, so it's a developer-workflow affordance, not something
an end user installing from a zip can use either. Worth a real fix later (an in-extension download into the
installed folder, for every OS) rather than something this plan can wave away; until then, say so plainly on the
site rather than implying voices "just work" on Windows. Once the Chrome Web Store
listing exists, Windows users installing from the store need none of this — the install script and `.ps1` only
matter for the sideload path.

## Updates

- **Sideload (today):** no auto-update. Re-running `install.sh` (or `install.ps1`) re-downloads `latest.json`,
  compares the version, and overwrites the same stable folder if it's newer — the user still has to click
  "Reload" on the extensions page (Chrome does not watch an unpacked folder for changes). Worth a once-a-day or
  once-a-week reminder from the extension itself eventually (not built; out of scope here).
- **Chrome Web Store / Edge Add-ons:** the browser checks for updates on its own schedule (Chrome: roughly every
  few hours) and applies them silently. This is the actual "updates" win of being in a store — not the install
  step.

## The optional Mac companion, "Avi Brain"

`companion/` is a separate local Node process the extension can pair with (`Settings › Avi Brain`) for things a
browser extension cannot do by itself: a Docker sandbox per agent, `gh` with a click-to-approve allowlist, local
(stdio) MCP servers, routines that run with Brave closed, and artifacts shown in an "Avi Studio" tab. It needs
**Node 24+ and Docker Desktop (or OrbStack/Colima)** and is installed separately (`cd companion && pnpm install &&
sh scripts/install-launchagent.sh`), pairing with an 8-character one-time code. The extension works fully without
it.

**Recommendation: keep it out of the "install for other people" v1.** It was only just built (`docs/task.md`,
"Wave 2 — WS7 Avi Brain," 2026-10-12) and still has pieces not wired up (routines syncing, its MCP tools as a
connector, sandboxed agent sessions). It also assumes a fair amount of comfort with Docker and the terminal —
exactly the audience this distribution effort is trying to not require. Document it on the site as "optional, for
people comfortable with Docker," link to `companion/README.md`, and revisit broader packaging (a signed macOS app,
a Docker Compose one-liner) once WS7 itself is finished.

## Recommendation and next three steps

**Ship the install-script path now; treat the Chrome Web Store as the deliberate next project, not a quick
follow-up.** The script path needs no money, no account and no review, and it is a real "one command plus one
click" — good enough to call this done for v1. The Store path is where the actual one-click install lives, but
`debugger` + `<all_urls>` make it a slow review, and it needs the owner's time and a small card charge before any
of that review even starts.

1. **Done for this pass**: `scripts/release.mjs` built end to end, and `install.sh` was run against a local server
   for install, update, `--uninstall` (including a non-interactive-shell edge case this testing found and fixed —
   it was crashing instead of asking to re-run with `--yes`), a corrupted zip, and a missing `latest.json`, then
   loaded for real in Brave. Before the first real release: run the same pass again from an actual clean checkout
   (not this worktree) and, ideally, on a Linux box — only macOS was available here.
2. **Owner: register the $5 Chrome Web Store developer account**, and do one throwaway/unlisted upload with `key`
   still in the manifest to settle the one open question above (does the Store keep
   `fckijnclcihjnokahdnbogpbeiimfdio`, or assign a new ID) before writing the real listing or touching the OAuth
   clients.
3. **Get the site's `/privacy` route live** (it's already planned in `site/docs/ARCHITECTURE.md`) and have it read
   the permission table above, or an equivalent of it, so the Store submission's justifications and the public
   privacy page never say different things about the same permission.
