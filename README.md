# Ava Copilot

Ava is a personal AI assistant that lives in your browser's side panel. She works on the pages and tabs you already
use, keeps your tasks and the people in them, takes meeting notes, talks, answers on WhatsApp and runs a small team of
helper agents, with the model you choose.

**Its one rule: nothing is sent, posted, bought, deleted or committed without your click.**

- **Website, install guide and every feature: https://ava.nexprove.com**
- What changed lately: [CHANGELOG.md](CHANGELOG.md), also at https://ava.nexprove.com/changelog
- Brave, Chrome and Edge on macOS, Linux and Windows. Free for personal use, no analytics, no server of ours: your
  data stays in your browser and goes only to the model and services you choose.

## What she does

The full list, with what each feature is, what you do and what tells you it is on, is at
**https://ava.nexprove.com/features**. In short:

- **Your browser and tabs** ([page](https://ava.nexprove.com/features/browser)): plans, clicks and types on real
  pages; works in the tab you already have open; reopens a closed tab and carries on; tries a failed task again, then
  tells you.
- **Your tasks and people** ([page](https://ava.nexprove.com/features/tasks)): one task board that ticks the same
  everywhere (the morning brief, meeting notes, the Tasks page); people learned per workspace from Meet, calendar,
  Gmail, Slack, WhatsApp and GitHub; screen recording for a task, saved to Drive.
- **Workspaces** ([page](https://ava.nexprove.com/features/workspaces)): one per project, never mixed; make one in a
  click or by voice, and loose things are sorted into them for you.
- **Calls and voice** ([meetings](https://ava.nexprove.com/features/meetings),
  [voice](https://ava.nexprove.com/features/voice), [listening](https://ava.nexprove.com/features/ambient)): notes
  for Google Meet, an on-device "Hey Ava", free local voices, and words she mishears spelled right everywhere.
- **WhatsApp** ([page](https://ava.nexprove.com/features/whatsapp), preview): message her from your phone, send
  `tasks` and then `done 2` (the tasks commands arrive with the next download, and Ava Brain needs updating for
  them). Needs Ava Brain on your Mac.
- **Your team of agents** ([page](https://ava.nexprove.com/features/team)): routines, an Inbox, a morning brief, and
  three growth agents that draft; you decide. They do not post or send yet.
- **Safety and control** ([the gate](https://ava.nexprove.com/features/gate),
  [privacy](https://ava.nexprove.com/privacy)): every send, post, delete, purchase and permission change waits for
  your click; "Allow every time" is a rule you make and can remove; a retry does not repeat a send on its own.
- **Models and connections** ([models](https://ava.nexprove.com/features/models),
  [integrations](https://ava.nexprove.com/features/integrations)): ten providers or fully local; GitHub, Linear,
  Notion, Slack, Gmail, Calendar and Drive, and any MCP server.

Some of this is merged and arrives with the next download; the changelog says which.

## Install

```bash
curl -fsSL https://ava.nexprove.com/install.sh | bash
```

Then open your browser's extensions page, switch on **Developer mode**, click **Load unpacked** and choose the
folder the command printed. No terminal? Download the
[latest build](https://ava.nexprove.com/download/ava-copilot-latest.zip), unzip it, and load that folder the same
way. Windows has a PowerShell installer in preview. Every way in, step by step:
**https://ava.nexprove.com/install**

Updating is the same command again, then **Reload** on the extension's card. The extension tells you when a new
version is out (a banner in the panel and one notification per version).

### Connect Ava Brain, WhatsApp and Google Drive (optional)

Ava works fully without these. Step by step, with the settings pages named:
**https://ava.nexprove.com/install#connect**.

- **Ava Brain**, the companion on your Mac. It is not one command yet. It needs Node 24 and, for the code sandbox,
  Docker.

  ```bash
  git clone https://github.com/AviOfLagos/ava-copilot.git && cd ava-copilot/companion
  corepack enable && pnpm install && sh scripts/install-launchagent.sh
  ```

  It prints a pairing code. In Ava, open **Settings › Ava Brain**, enter port `47615` and the code, and press **Pair**.
  Details are in [companion/README.md](companion/README.md).
- **WhatsApp** (preview): pair Ava Brain, then **Settings › WhatsApp › Link WhatsApp** and scan the code from
  WhatsApp › Linked devices. It uses an unofficial WhatsApp Web client, which WhatsApp can restrict.
- **Google Drive**: **Connectors › Google Drive**, sign in. Screen recordings then go to a private folder in Drive.

## Found a problem? Have an idea?

[Open an issue](https://github.com/AviOfLagos/ava-copilot/issues/new/choose). The forms ask for your version,
browser and steps, so someone can pick it up and fix it. In the extension, **Settings › Help › Report a problem**
opens the form with your version and browser already filled in. Security problems go privately through
[SECURITY.md](SECURITY.md).

## Build from source

Node.js 24 and pnpm 10 (run `corepack enable` once).

```bash
git clone https://github.com/AviOfLagos/ava-copilot.git && cd ava-copilot
corepack enable && pnpm install
pnpm dev   # then Load unpacked the dist/ folder
```

Before a pull request: `pnpm type-check && pnpm test`, and lint only the files you changed
(`pnpm exec eslint <paths> --ext .ts,.tsx`; plain `pnpm lint` rewrites the whole repository). Start with
[CONTRIBUTING.md](CONTRIBUTING.md): local setup in five minutes, the rules every change follows, and the tools that
make it quick. Issues marked **good first issue** are a good start. The website is in `site/`
([its README](site/README.md)); Ava Brain is in `companion/`.

## How it is built

- **Extension:** WXT, Manifest V3, React and TypeScript. State lives in IndexedDB in your browser.
- **Models:** the Vercel AI SDK; 10 providers built in, plus any OpenAI-compatible endpoint, Ollama and LM Studio.
- **Voice:** Moonshine, Whisper, Vosk, KittenTTS and Kokoro, running on your computer.
- **Ava Brain** (`companion/`): an optional companion on the Mac for sandboxed code, WhatsApp, Ava Keys and routines
  while the browser is closed.
- **Website** (`site/`): Astro, static, no third-party scripts. Its changelog page is built from `CHANGELOG.md`.

## Where the specs and plans live

| Read | For |
| --- | --- |
| [docs/spec.md](docs/spec.md) | The original build spec (meeting notes, knowledge base, threads, skills) |
| [docs/roadmap.md](docs/roadmap.md) | The order things were asked for, and the rules that never bend |
| [docs/pm-desk.md](docs/pm-desk.md) | Tasks, people, vocabulary, workspaces, WhatsApp tasks, recordings, follow-ups |
| [docs/growth-team.md](docs/growth-team.md) | Open tabs, retries, do-once keys, rounds, and the three growth agents |
| [docs/ava-keys.md](docs/ava-keys.md) | Ava Keys: a coding agent asks for a command that needs your secrets |
| [docs/ambient-plan.md](docs/ambient-plan.md) | Listening, the scribe and when Ava speaks |
| [docs/distribution.md](docs/distribution.md) | How Ava gets onto other people's machines |
| [docs/task.md](docs/task.md) | The running build log and decisions |

## Licence, sign-off and lineage

Free for personal and other noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). The code
is public and contributions are welcome, but commercial use needs permission. Sign off every commit
(`git commit -s`) to certify the [Developer Certificate of Origin](DCO); a check fails a pull request with an
unsigned commit. Ava Copilot is a fork of [Nanobrowser](https://github.com/nanobrowser/nanobrowser); the parts from
Nanobrowser stay under Apache-2.0 ([LICENSE-APACHE](LICENSE-APACHE)). See [NOTICE](NOTICE).
