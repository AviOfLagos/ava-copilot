import type { AgentContext } from '../agent/types';
import { createLogger } from '../log';
import { callerOf } from './caller';
import { catalogueSection } from './catalogue';
import { connectorService } from './instance';
import type { ConnectorService } from './service';

const logger = createLogger('Connectors');

/**
 * The [Connector tools] section of a step's browser state: the tools this chat may call, read fresh at every step
 * (so a tool the user turns off or on mid-chat is seen at once). '' when the chat may use none.
 */
export async function toolCatalogueSectionFor(
  service: ConnectorService,
  context: Pick<AgentContext, 'taskId'>,
): Promise<string> {
  try {
    const { scope } = await callerOf(context);
    if (!scope.workspaceId) return '';
    const { tools, needSignIn } = await service.usableTools(scope);
    return catalogueSection(tools, needSignIn);
  } catch (error) {
    logger.error('Could not list the connector tools', error);
    return '';
  }
}

/** For agent/prompts/base.ts, next to the workspace and skills sections. */
export function connectorToolsSectionFor(context: Pick<AgentContext, 'taskId'>): Promise<string> {
  return toolCatalogueSectionFor(connectorService, context);
}
