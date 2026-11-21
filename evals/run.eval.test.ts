/**
 * Ava's evals: every case under evals/cases (from failures found by hand) and evals/suture (from failing traces,
 * written by Suture), replayed through Ava's own code. `pnpm eval` prints one PASS/FAIL line per case and
 * "evals: N total, P passed, F failed", which is what Suture's verifier reads before and after a fix.
 *
 * Planner cases replay the model's recorded replies, so they need no model and test the code around it. With
 * AVA_EVAL_OLLAMA_MODEL=qwen3:4b they ask that model instead and also check each case's `live` expectations.
 */
import 'fake-indexeddb/auto';
import { join } from 'node:path';
import { beforeAll, describe, it, vi } from 'vitest';
import { enT } from '@src/background/skills/__tests__/en';
import { loadCases } from './runner/cases';
import { runDraftCase } from './runner/draft';
import { runLeadCase } from './runner/lead';
import { LIVE_MODEL, runPlannerCase } from './runner/planner';
import { runSkillsCase } from './runner/skills';
import { runVoiceCase } from './runner/voice';

vi.mock('@extension/i18n', () => ({ t: enT }));

// The built-in skills, as a fresh install has them
vi.mock('@extension/storage', async importOriginal => {
  const storage = await importOriginal<typeof import('@extension/storage')>();
  return { ...storage, skillStore: { ...storage.skillStore, enabled: async () => storage.builtinSkills() } };
});

// Every registration loads as at startup, so the planner is told the abilities the extension has; Chrome is a stub
// that answers every call with nothing
const chromeStub: unknown = new Proxy(function () {}, {
  get: (_target, key) => (key === 'then' ? undefined : chromeStub),
  apply: () => Promise.resolve(undefined),
});

const cases = loadCases(join(import.meta.dirname));

describe(LIVE_MODEL ? `evals (live: ${LIVE_MODEL})` : 'evals', () => {
  beforeAll(async () => {
    vi.stubGlobal('chrome', chromeStub);
    await import('@src/background/registers');
  });

  for (const { evalCase } of cases) {
    const timeout =
      evalCase.kind === 'planner' && LIVE_MODEL ? Number(process.env.AVA_EVAL_TIMEOUT_MS) || 300_000 : 20_000;
    it(evalCase.name, { timeout }, async () => {
      if (evalCase.kind === 'planner') await runPlannerCase(evalCase);
      else if (evalCase.kind === 'skills') await runSkillsCase(evalCase);
      else if (evalCase.kind === 'draft') runDraftCase(evalCase);
      else if (evalCase.kind === 'lead') await runLeadCase(evalCase);
      else await runVoiceCase(evalCase);
    });
  }
});
