import { db } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { registerVoiceTool } from '../registry';
import { agentLine, agentRunResult } from './actions';
import { isDraftAgent } from './profile';
import type { AgentService } from './service';
import { findAgent } from './service';

/** Agents by voice: hear the list, or run one by name. Both are guarded like every registered tool. */

// A spoken answer should not keep the user waiting long; the run goes on and the panel shows it
const VOICE_WAIT_MS = 20_000;

export function registerAgentVoiceTools(service: AgentService): void {
  registerVoiceTool({
    declaration: {
      name: 'list_agents',
      description:
        "Lists the user's agents (they work on their own in a window of their own): their names, whether they are on, when they run and what they spent today.",
    },
    guardLabel: 'list your agents',
    async handler() {
      const agents = await db.agents.toArray();
      if (!agents.length) return 'The user has no agents yet.';
      return (await Promise.all(agents.map(agentLine))).join('\n');
    },
  });

  registerVoiceTool({
    declaration: {
      name: 'run_agent',
      description:
        'Runs one of the user\'s agents now, by its name (e.g. "Research scout"), in its own window, and says what it found. Use list_agents first when unsure of the name.',
      parameters: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING', description: 'the agent name as the user said it' } },
        required: ['name'],
      },
    },
    guardLabel: 'run one of your agents',
    async handler(args) {
      const name = String(args.name ?? '');
      const agent = findAgent(
        (await db.agents.toArray()).filter(item => !isDraftAgent(item)),
        name,
      );
      if (!agent) return `There is no agent called "${name}".`;
      try {
        const run = await service.requestRun(agent.id, {
          trigger: { type: 'voice', detail: '' },
          attended: true,
          tainted: false,
        });
        return `Started "${agent.name}". ${await agentRunResult(run.id, VOICE_WAIT_MS)}`;
      } catch (error) {
        return toAppError(error).message;
      }
    },
  });
}
