/* eslint-disable @typescript-eslint/no-unused-vars */
import { BasePrompt } from './base';
import type { SystemModelMessage, UserModelMessage } from '@src/background/llm/types';
import { systemMessage, userMessage } from '@src/background/llm/messages';
import type { AgentContext } from '@src/background/agent/types';
import { plannerSystemPromptTemplate } from './templates/planner';
import { buildIdentitySection, buildStyleSection } from './style';
import { plannerGateSection } from '@src/background/gate/prompt';
import { plannerKnowledgeSection } from '@src/background/kb/action';
import { buildPersonalitySection } from '@src/background/personalities/prompt';
import type { Personality } from '@extension/storage';

export class PlannerPrompt extends BasePrompt {
  constructor(
    private readonly stylePrompt = '',
    private readonly assistantName?: string,
    // The user's chosen personality, added last: below the rules, which it cannot override
    private readonly personality?: Personality | null,
  ) {
    super();
  }

  getSystemMessage(): SystemModelMessage {
    return systemMessage(
      plannerSystemPromptTemplate +
        buildIdentitySection(this.assistantName) +
        plannerGateSection +
        plannerKnowledgeSection +
        buildStyleSection(this.stylePrompt, 'the "final_answer" field') +
        buildPersonalitySection(this.personality, 'the "final_answer" field'),
    );
  }

  async getUserMessage(context: AgentContext): Promise<UserModelMessage> {
    return userMessage('');
  }
}
