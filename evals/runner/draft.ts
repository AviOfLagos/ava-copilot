import { expect } from 'vitest';
import { BUILTIN_PERSONALITIES } from '@extension/storage';
import { personaRefusal } from '@src/background/growth-team/persona';
import { buildPersonalitySection } from '@src/background/personalities/prompt';
import type { DraftCase } from './cases';

/**
 * A recorded draft through the check `propose` runs before anything reaches the Inbox, and the personality's
 * section as the model gets it. A recorded draft cannot show the model behaves; it shows a draft that names the
 * person, or speaks as them, never gets past code.
 */
export function runDraftCase(evalCase: DraftCase): void {
  const personality = BUILTIN_PERSONALITIES.find(item => item.id === evalCase.personality);
  expect(personality, `built-in personality ${evalCase.personality}`).toBeDefined();
  const prompt = buildPersonalitySection(personality, 'the draft');
  for (const source of evalCase.expect.prompt_matches ?? []) {
    expect(prompt, 'personality prompt').toMatch(new RegExp(source, 'i'));
  }
  const why = personaRefusal(evalCase.action, evalCase.replay.title, evalCase.replay.text);
  if (!evalCase.expect.refused) {
    expect(why, 'refusal').toBeNull();
    return;
  }
  expect(why, 'refusal').not.toBeNull();
  for (const source of evalCase.expect.why_matches ?? []) expect(why).toMatch(new RegExp(source, 'i'));
}
