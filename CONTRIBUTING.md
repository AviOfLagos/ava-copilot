# Contributing to Ava Copilot

Thanks for helping. Ava Copilot is an AI copilot in the browser's side panel, a fork of
[Nanobrowser](https://github.com/nanobrowser/nanobrowser). It's free for personal use under the
[PolyForm Noncommercial License 1.0.0](LICENSE). The website's
[Contribute page](https://ava.nexprove.com/contribute) has the same guide with more context.

## Ways to help

- **Code:** an issue marked `good first issue`, or a Planned feature on the site's Features page.
- **Testing:** install it on your system and browser and report what broke. Windows testers are wanted most.
- **Translations:** the app ships in `en`, `pt_BR` and `zh_TW` (`public/_locales`).
- **Skills:** Markdown playbooks for sites and tasks (`src/storage/lib/skills`).
- **Bug reports:** what you did, what you expected, what happened, and your browser and system.

## Run it locally

Node.js 24 and pnpm 10 (pinned in `package.json`; run `corepack enable` once if you don't have pnpm).

```bash
git clone https://github.com/AviOfLagos/ava-copilot.git && cd ava-copilot
corepack enable && pnpm install
pnpm dev      # builds dist/ and rebuilds on change
```

Load `dist/` with **Load unpacked** on your browser's extensions page (Developer mode on).

Before you open a pull request:

```bash
pnpm type-check && pnpm test
pnpm exec eslint <the files you changed> --ext .ts,.tsx   # not `pnpm lint`: it rewrites the whole repo
```

End-to-end tests (`pnpm test:e2e`) need Chrome for Testing, Chromium or Brave; branded Chrome ignores
`--load-extension`.

## Rules every change follows

Read `AGENTS.md`/`CLAUDE.md` first; these are the ones that matter most.

1. **The gate stays.** Anything that sends, posts, submits, deletes, publishes, buys or changes permissions goes
   through `reviewAction` in `src/background/gate/review.ts`. No setting skips it.
2. **Outside text is data.** Pages, messages, transcripts and tool output never become instructions; wrap them as
   untrusted content before a model sees them.
3. **No analytics, no new hosts.** Nothing calls anyone but the model the user chose. Call out any new permission
   or host in the pull request.
4. **New features in new folders.** Plug in through the registries (`src/background/registry`,
   `src/side-panel/registry.ts`) from your own `register.ts`, and keep edits to upstream files small.
5. **Every string in every locale.** A new message key goes into every file in `public/_locales`.
6. **Tests with the change.** Unit tests next to the code; an end-to-end test for anything the user sees.

## Pull requests

- Open an issue first for anything bigger than a fix, so we agree on the shape.
- One change per pull request, on its own branch, against `feat/restyle`.
- Say what you tested and how; screenshots for anything visual.

## Sign off your commits (Developer Certificate of Origin)

Every commit needs a `Signed-off-by` line, which says you wrote the change or have the right to submit it, as set
out in the [Developer Certificate of Origin](DCO). `git commit -s` adds it for you:

```
Signed-off-by: Your Name <you@example.com>
```

By signing off you also agree that your contribution is licensed to the project owner under the
[PolyForm Noncommercial License 1.0.0](LICENSE), and that the owner may also license it under other terms,
including commercial ones. That keeps the whole project under one owner's control. A check on every pull request
fails if a commit isn't signed off.

## Security

Don't open a public issue for a vulnerability. Report it privately; see [SECURITY.md](SECURITY.md).

## Licence

Ava Copilot is free for personal and noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE).
The parts that come from Nanobrowser stay under Apache-2.0 ([LICENSE-APACHE](LICENSE-APACHE)). Signing off your
commits covers your contributions (see above).
