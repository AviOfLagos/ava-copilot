# Ava desktop app

Decided 28 Nov 2026. New work lands in the desktop app; the extension keeps being the browser's hands. Epic: see
"Desktop app" on GitHub (links every issue below).

## 1. Decision

**Shell: Electron. Place: a `desktop/` package in this repo**, with its own `package.json` and lockfile (like
`companion/`).

Why Electron and not Tauri:

| | Electron | Tauri |
|---|---|---|
| Ava Brain (Node: Baileys, MCP SDK, eve, croner) | runs as it is, in a utility process of the app | needs Node shipped as a sidecar anyway: two runtimes, plus Rust for anything native |
| The React side panel UI | same Chromium the panel was built and tested on (`zoom`, `color-mix`, container queries) | WKWebView on the Mac: a second engine to test every screen on |
| Size | ~100 MB more | small |
| Overlay window for Ava Keys pointers (`docs/ava-keys.md` §7) | transparent always-on-top `BrowserWindow` | possible, Rust |

The size is the only cost, and it is one Mac. The team plan (§6) and `docs/ava-keys.md` §9 already assumed Electron.

Why in this repo: the app reuses `src/shared` (the Ava Brain protocol), the appearance record and its pure functions
(`src/storage/lib/settings/appearanceSettings.ts`), the side panel's tokens (`src/side-panel/index.css`) and
components, and `companion/` itself. One repo keeps one protocol file and one PR per change across all three.

## 2. Architecture

```
Ava desktop app (Electron, desktop/)
├─ main process: window, tray, login item; the only holder of the Ava Brain token
│   └─ Ava Brain ─ today the LaunchAgent (com.avicopilot.brain); from D3 a utility process of the app
├─ preload: a narrow `window.ava` bridge (contextIsolation on, sandbox on, no Node in the page)
└─ renderer: React, the side panel's look and components, the appearance record applied as on the panel
        │ HTTP 127.0.0.1:47615, desktop token (no Origin header, like eve's internal routes)
        ▼
Ava Brain ──queue──▶ Ava Copilot extension (pulls, runs the chat with all its tools, keys and memory, replies)
```

- **Auth.** Ava Brain writes a random token to `desktop.token` in its data folder (mode 0600) at every start. The
  app's main process reads it and sends it as a bearer with no `Origin` header. Web pages always send an `Origin`,
  so they cannot use these routes, and a process running as the user can already read Ava Brain's folder (its
  WhatsApp session, its store), so the file widens nothing. The page in the window never sees the token.
- **Chat, from D1.** The window sends a message to Ava Brain's desktop queue; the extension pulls it like a
  WhatsApp message, runs it as a chat (origin `desktop`) with everything Ava has, and sends the answer back; the
  window polls for it. When the browser is closed the window says "Open your browser and I'll answer". This gives
  the real Ava in the window on day one, without porting the agent first.
- **Agent loop, from D7.** The planner/navigator, threads, knowledge base, skills and the gate move into the app
  (Node + IndexedDB in the renderer, or SQLite in main), and the extension shrinks to the browser's hands (tabs,
  DOM, CDP), paired with Ava Brain as today. Only then can Ava answer with the browser closed.
- **Appearance.** Same record (`theme`, `textScale`, `density`), same `normalizeAppearance`/`appearanceCss`, applied
  as root `zoom`, `--density` and `data-theme`, as `docs/appearance.md` asks. The app keeps its own copy in
  Electron's store until D7 makes it shared; changing it in one does not change the other before that.

## 3. What moves, what stays

| Moves to the desktop app | Stays in the extension |
|---|---|
| The Ava window: chat, Inbox, WhatsApp, Keys (#61), Agents (#38) | Tabs, pages, DOM reading, clicks, CDP, `hover_element` |
| Ava Brain's host: the app starts it, keeps it alive, shows its health (D3) | The side panel, for in-page work and meetings in Chrome |
| WhatsApp setup and abilities (#207) | Meeting recording of a Chrome tab (Chrome only lets the extension do it) |
| From D7: the agent loop, threads, memory, skills, the gate | The confirm cards shown in a page (the gate's decision moves, the card can stay) |

Ava Brain itself does not change shape: the same routes, the same store in `~/Library/Application Support/Avi Brain`,
so the LaunchAgent and the app can be swapped without losing pairing, WhatsApp or config.

## 4. Updates and signing on macOS

- **Now (Avi's Mac only):** the app is built locally and signed ad hoc, like `Ava Brain.app`. First open is a
  right-click › Open once. Privacy permissions (microphone, screen recording, calendar) are tied to the signature,
  and an ad-hoc signature changes every build, so macOS would ask again after each update. To avoid that, the build
  signs with a self-signed "Ava Local" certificate kept in the login keychain (free, made once by a script).
- **To give it to anyone else:** an Apple Developer ID (Apple Developer Program, $99 a year: Avi's decision, not
  bought) for signing, plus notarization (`notarytool`) so Gatekeeper opens it without warnings.
- **Updates:** `electron-builder` + `electron-updater` from GitHub Releases of this repo, once it is signed with a
  Developer ID (the updater refuses an unsigned Mac app). Before that, an update is "pull, `pnpm build`, replace".
- No release to users and no website change until Avi says so.

## 5. Phases

Every phase ships with a short screen demo.

| Phase | What | Issues |
|---|---|---|
| D0 | This document; the epic | — |
| D1 | Scaffold: the app launches, shows the Ava chat (relayed to the extension), Ava Brain's health and WhatsApp state, and applies appearance | new: D1 scaffold |
| D2 | WhatsApp, full abilities, in the epic's order: tool awareness, voice/text on request, then pictures/videos/files, then join code + groups (one access model), then messaging others | #207: #202, #203, #204, #205, #20, #206 |
| D3 | The app hosts Ava Brain (utility process), replaces the LaunchAgent, starts at login, tray icon | new |
| D4 | Carry-overs from the extension into the window: Auto mode (#188), live retry countdowns (#189), per-window/per-site conversations (the panel's per-tab chats, #195); hover actions (#190) stay in the extension's navigator and need nothing here | new, one per feature |
| D5 | Ava Keys view: pending requests, live approvals, activity log, agents' off switches | #61 |
| D6 | Agents screen rework, with room the 400 px panel never had | #38 |
| D7 | The agent loop in the app; the extension becomes the hands only | new |
| D8 | Signing with a stable certificate, updates, and (on Avi's yes) Developer ID and notarization | new |

D2's WhatsApp work lives in Ava Brain (`companion/src/whatsapp`) and the extension's bridge
(`src/background/whatsapp-remote`) until D7 moves the bridge into the app; the app shows and sets it.
