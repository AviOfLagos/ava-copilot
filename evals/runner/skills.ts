import { expect } from 'vitest';
import type { AgentContext } from '@src/background/agent/types';
import { skillSectionFor } from '@src/background/skills/inject';
import type { SkillsCase } from './cases';

/** The skills Ava pulls in for the case's message on the case's tab, by the notice she shows for each. */
export async function runSkillsCase(evalCase: SkillsCase): Promise<void> {
  const used: string[] = [];
  const context = {
    taskId: `eval-${evalCase.name}`,
    tasks: [evalCase.input],
    emitEvent: (_actor: string, _state: string, details: string) => {
      const skill = /\/([\w-]+)/.exec(details)?.[1];
      if (skill) used.push(skill);
    },
  } as unknown as AgentContext;
  const section = await skillSectionFor(context, evalCase.url);
  expect(used, 'skills used').toEqual(evalCase.expect.skills);
  if (!evalCase.expect.skills.length) expect(section, 'skills section').toBe('');
}
