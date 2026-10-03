/* eslint-disable @typescript-eslint/no-unused-vars */
import { BasePrompt } from './base';
import type { SystemModelMessage, UserModelMessage } from '@src/background/llm/types';
import { systemMessage, userMessage } from '@src/background/llm/messages';
import type { AgentContext } from '@src/background/agent/types';
import { plannerSystemPromptTemplate } from './templates/planner';
import { buildStyleSection } from './style';
import { plannerGateSection } from '@src/background/gate/prompt';
import { plannerKnowledgeSection } from '@src/background/kb/action';

export class PlannerPrompt extends BasePrompt {
  constructor(private readonly stylePrompt = '') {
    super();
  }

  getSystemMessage(): SystemModelMessage {
    return systemMessage(
      plannerSystemPromptTemplate +
        plannerGateSection +
        plannerKnowledgeSection +
        buildStyleSection(this.stylePrompt, 'the "final_answer" field'),
    );
  }

  async getUserMessage(context: AgentContext): Promise<UserModelMessage> {
    return userMessage('');
  }
}
