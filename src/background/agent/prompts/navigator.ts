import { registeredActionPrompts } from '@src/background/registry';
/* eslint-disable @typescript-eslint/no-unused-vars */
import { BasePrompt } from './base';
import type { SystemModelMessage, UserModelMessage } from '@src/background/llm/types';
import { systemMessage } from '@src/background/llm/messages';
import type { AgentContext } from '@src/background/agent/types';
import { createLogger } from '@src/background/log';
import { navigatorSystemPromptTemplate } from './templates/navigator';
import { buildIdentitySection, buildStyleSection } from './style';
import { navigatorGateSection } from '@src/background/gate/prompt';
import { navigatorReaderSection } from '@src/background/reader/reader';
import { navigatorKnowledgeSection } from '@src/background/kb/action';
import { buildPersonalitySection } from '@src/background/personalities/prompt';
import type { Personality } from '@extension/storage';

const logger = createLogger('agent/prompts/navigator');

export class NavigatorPrompt extends BasePrompt {
  private systemMessage: SystemModelMessage;

  constructor(
    private readonly maxActionsPerStep = 10,
    stylePrompt = '',
    assistantName?: string,
    // The user's chosen personality, added last: below the rules, which it cannot override
    personality?: Personality | null,
    // Who the assistant is and what she knows about the user (identity/prompt.ts), after the rules
    identitySection?: string,
    // Where the chat is (./channel.ts), after who she is
    channelSection = '',
  ) {
    super();

    // The gate and style sections go inside the system instructions, before the closing tag
    const promptTemplate = navigatorSystemPromptTemplate.replace(
      '</system_instructions>',
      () =>
        `${identitySection ? '' : buildIdentitySection(assistantName)}${navigatorGateSection}${navigatorReaderSection}${navigatorKnowledgeSection}${registeredActionPrompts()}${identitySection ?? ''}${channelSection}${buildStyleSection(stylePrompt, 'the text of the done action')}${buildPersonalitySection(personality, 'the text of the done action')}</system_instructions>`,
    );
    // Format the template with the maxActionsPerStep
    const formattedPrompt = promptTemplate.replace('{{max_actions}}', this.maxActionsPerStep.toString()).trim();
    this.systemMessage = systemMessage(formattedPrompt);
  }

  getSystemMessage(): SystemModelMessage {
    /**
     * Get the system prompt for the agent.
     *
     * @returns SystemMessage containing the formatted system prompt
     */
    return this.systemMessage;
  }

  async getUserMessage(context: AgentContext): Promise<UserModelMessage> {
    return await this.buildBrowserStateUserMessage(context);
  }
}
