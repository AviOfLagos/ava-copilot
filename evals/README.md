# Evals

Every failure we have found, replayed through Ava's own code, so it cannot come back unnoticed.

```bash
pnpm eval                                   # every case, recorded replies, no model needed (CI runs this)
AVA_EVAL_OLLAMA_MODEL=qwen3:4b pnpm eval    # planner cases ask that model instead, and check `live` too
```

It prints one line per case and the totals, which is what Suture's verifier reads before and after a fix:

```
PASS "Hi" on WhatsApp never gets "None"
FAIL On WhatsApp Ava knows she can answer with a voice note
  ↳ planner prompt: expected … not to match /Coming, not built yet:…voice note/i
evals: 6 total, 5 passed, 1 failed
```

## Where cases come from

- `cases/`: written by hand from a failure (`source` says when it was found and which PR fixed it).
- `suture/<issue>/<trace>.eval.json`: written by Suture from a failing trace when it proposes a fix. Each holds
  the user's message, the answer that failed and the model's recorded replies; the runner replays those replies
  through the planner, and the user must not get the failing answer, nor an empty one. Keep them: they are the
  regression tests for that fix.

## Case kinds

| kind | What it runs | What it checks |
|---|---|---|
| `planner` | The planner with the real prompt for `channel`, the model replaced by `replay.planner` (the last reply repeats for any further call) | `expect`: the answer (`answer_not_empty`, `answer_not`, `answer_matches`, `answer_not_matches`) and the system prompt the model got (`prompt_matches`, `prompt_not_matches`). `live`: checked only with a live model |
| `skills` | `skillSectionFor` with the built-in skills, for `input` on the tab `url` | `expect.skills`: the skills used, in order |
| `voice` | The on-device voice conversation (economy mode) fed `heard`: `{ say, level: near\|far, pause }`, `{ quiet }`, `{ wait_ms }` | `expect.turns`: the turns Ava answers, as she was asked them |
| (none) | A Suture case: replayed as a planner case | The failing answer is not given again; the answer is not empty |

A recorded reply cannot show that a better prompt makes a better answer: a case about what the model says
(`voice-notes-on-whatsapp`) checks what the model is told, and checks the answer under `live`.

## Traces

Each turn's trace (`src/background/telemetry/traces.ts`) goes to Ava Brain, which keeps it on the Mac in
`~/Library/Application Support/Avi Brain/traces/<day>.otlp.jsonl` for 14 days (`AVA_TRACES=off` keeps none).
Suture reads that folder (`pnpm ava --traces <folder>` in the Suture repo), flags the turns that went wrong, and
proposes a fix with a case here for each.
