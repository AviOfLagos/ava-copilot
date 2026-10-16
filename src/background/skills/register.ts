// Skills from anywhere: the panel's install and update commands, the chat actions and the voice tool (see ../registry).
import { toAppError } from '@extension/shared';
import { openInPanel } from '../capabilities/panel';
import { createLogger } from '../log';
import { registerAgentAction, registerCommand, registerVoiceTool } from '../registry';
import type { CommandContext } from '../registry';
import {
  checkUpdateSchema,
  handleCheckUpdate,
  handleInstall,
  installCommandSchema,
  installSkillAgentAction,
  installSkillVoiceTool,
  readSkillSectionAgentAction,
} from './install';

const logger = createLogger('Skills');

/** Runs a command and replies with its result, or with the error's plain sentence. */
async function answer(context: CommandContext, work: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    context.reply({ ...(await work()), requestId: context.requestId });
  } catch (error) {
    const appError = toAppError(error);
    logger.warning(`Skill command failed (${appError.kind})`);
    context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
  }
}

registerCommand('skills_install', installCommandSchema, (input, context) =>
  answer(context, () => handleInstall(input)),
);
registerCommand('skills_check_update', checkUpdateSchema, (input, context) =>
  answer(context, () => handleCheckUpdate(input)),
);
registerAgentAction(installSkillAgentAction());
registerAgentAction(readSkillSectionAgentAction());
registerVoiceTool(installSkillVoiceTool(() => openInPanel({ place: 'skills' })));
