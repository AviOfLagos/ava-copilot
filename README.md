# Ava Copilot

An AI copilot in your browser's side panel. It works on real pages, takes meeting notes, talks (with an on-device
"Hey Ava" wake word and free local voices), remembers what you saw, listens around you when you want it to, and
runs routines and helper agents with the model you choose, local or cloud.

**Its one rule: nothing is sent, posted, bought, deleted or committed without your click.**

- Website, install and every feature: **https://ava.nexprove.com**
- Brave, Chrome and Edge on macOS, Linux and Windows. Free for personal use, no analytics, no server of ours.

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

## Found a problem? Have an idea?

[Open an issue](https://github.com/AviOfLagos/ava-copilot/issues/new/choose). The forms ask for your version,
browser and steps, so someone can pick it up and fix it. In the extension, **Settings › Help › Report a problem**
opens the form with your version and browser already filled in. Security problems go privately through
[SECURITY.md](SECURITY.md).

## Contribute

Anyone can pick up an issue, including one they reported. Start with
[CONTRIBUTING.md](CONTRIBUTING.md): local setup in five minutes, the rules every change follows, and the tools that
make it quick. Issues marked **good first issue** are a good start.

```bash
git clone https://github.com/AviOfLagos/ava-copilot.git && cd ava-copilot
corepack enable && pnpm install
pnpm dev   # then Load unpacked the dist/ folder
```

## How it is built

- **Extension:** WXT, Manifest V3, React and TypeScript. State lives in IndexedDB in your browser.
- **Models:** the Vercel AI SDK; 10 providers built in, plus any OpenAI-compatible endpoint, Ollama and LM Studio.
- **Voice:** Moonshine, Whisper, Vosk, KittenTTS and Kokoro, running on your computer.
- **Ava Brain** (`companion/`): an optional companion on the Mac for sandboxed code and routines while the browser
  is closed.
- **Website** (`site/`): Astro, static, no third-party scripts.

## Licence and lineage

Free for personal and other noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). The code
is public and contributions are welcome, but commercial use needs permission. Ava Copilot is a fork of
[Nanobrowser](https://github.com/nanobrowser/nanobrowser); the parts from Nanobrowser stay under Apache-2.0
([LICENSE-APACHE](LICENSE-APACHE)). See [NOTICE](NOTICE).
