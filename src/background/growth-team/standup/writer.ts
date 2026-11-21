import { personalityStore } from '@extension/storage';
import { generatePlainText, generateStructured } from '../../llm/generate';
import { systemMessage, userMessage } from '../../llm/messages';
import { createRoleModel } from '../../models/roles';
import { buildPersonalitySection } from '../../personalities/prompt';
import { claudeProviderId, GROWTH_MODELS } from '../setup';
import { noteSchema, planSchema } from './run';
import type { StandupWriter, WriterRequest } from './run';

/**
 * The standup's model calls (docs/growth-team.md, Part 8, "Models"): the Monday plan on Opus when a Claude key is
 * set, everything else on the agent's own `smart` role (Sonnet for a growth agent with a Claude key). Each agent
 * writes in its own personality. Usage is metered to the agent and the workspace.
 */

async function modelFor(request: WriterRequest) {
  const providerId = request.task === 'plan' ? await claudeProviderId() : null;
  const { chatModel } = await createRoleModel('smart', {
    agentId: request.agent.id,
    workspaceId: request.agent.workspaceId ?? null,
    sessionId: `growth-standup:${request.agent.workspaceId ?? ''}`,
    notify: () => {},
    explicit: providerId ? { providerId, model: GROWTH_MODELS.weekly } : null,
  });
  return chatModel;
}

async function system(request: WriterRequest): Promise<string> {
  const personality = request.agent.personalityId
    ? (await personalityStore.list().catch(() => [])).find(item => item.id === request.agent.personalityId)
    : null;
  return `${request.system}${personality ? `\n${buildPersonalitySection(personality, 'your text')}` : ''}`;
}

export const modelWriter: StandupWriter = {
  async plan(request) {
    const { output } = await generateStructured({
      chatModel: await modelFor(request),
      messages: [systemMessage(await system(request)), userMessage(request.prompt)],
      schema: planSchema,
      name: 'weekly_plan',
    });
    return output;
  },
  async note(request) {
    const { output } = await generateStructured({
      chatModel: await modelFor(request),
      messages: [systemMessage(await system(request)), userMessage(request.prompt)],
      schema: noteSchema,
      name: 'standup_note',
    });
    return output;
  },
  async text(request) {
    return generatePlainText({
      chatModel: await modelFor(request),
      messages: [systemMessage(await system(request)), userMessage(request.prompt)],
    });
  },
};
