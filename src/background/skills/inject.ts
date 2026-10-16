import { t } from '@extension/i18n';
import { skillStore } from '@extension/storage';
import type { AgentContext } from '../agent/types';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { createLogger } from '../log';
import { matchSkills, skillsSection } from './match';

const logger = createLogger('Skills');

// The skills each task has announced, so the thread says once which skill it uses
const announced = new Map<string, Set<string>>();

/**
 * The skills section for one step of a task on the page at `url`: matched again every step, so a
 * task that moves to another site picks up that site's skill. Says in the thread when a skill is
 * first used. Never fails a step: without skills the agent still works.
 */
export async function skillSectionFor(context: AgentContext, url: string): Promise<string> {
  try {
    const task = context.tasks.join('\n');
    const matches = matchSkills(await skillStore.enabled(), { url, task });
    const seen = announced.get(context.taskId) ?? new Set<string>();
    announced.set(context.taskId, seen);
    for (const { skill } of matches) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      context.emitEvent(Actors.SYSTEM, ExecutionState.ACT_NOTICE, t('skills_using', [skill.id]));
    }
    return skillsSection(matches, text => wrapUntrustedContent(text));
  } catch (error) {
    logger.error('Could not load skills', error);
    return '';
  }
}
