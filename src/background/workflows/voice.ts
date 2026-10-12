import { db } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { registerVoiceTool } from '../registry';
import { findWorkflow, runResult, workflowLine } from './actions';
import type { WorkflowService } from './service';

/** Workflows by voice: run one by name, or hear the list. Both are guarded like every registered tool. */

// A spoken answer should not keep the user waiting long; the run goes on and the panel shows it
const VOICE_WAIT_MS = 20_000;

export function registerWorkflowVoiceTools(service: WorkflowService): void {
  registerVoiceTool({
    declaration: {
      name: 'run_workflow',
      description:
        'Runs one of the user\'s workflows (routines, e.g. "Morning tech news") now, by its name, and says how it went. Use list_workflows first when unsure of the name.',
      parameters: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING', description: 'the workflow name as the user said it' } },
        required: ['name'],
      },
    },
    guardLabel: 'run one of your workflows',
    async handler(args) {
      const workflows = (await db.workflows.toArray()).filter(item => item.status !== 'draft');
      const workflow = findWorkflow(workflows, String(args.name ?? ''));
      if (!workflow) return `There is no workflow called "${String(args.name ?? '')}".`;
      try {
        const run = await service.start(workflow.id, { trigger: { type: 'voice', detail: '' }, attended: true });
        return `Started "${workflow.name}". ${await runResult(run.id, VOICE_WAIT_MS)}`;
      } catch (error) {
        return toAppError(error).message;
      }
    },
  });

  registerVoiceTool({
    declaration: {
      name: 'list_workflows',
      description: "Lists the user's workflows (routines): their names, when they run and how the last run went.",
    },
    guardLabel: 'list your workflows',
    async handler() {
      const workflows = await db.workflows.toArray();
      return workflows.length ? workflows.map(workflowLine).join('\n') : 'The user has no workflows yet.';
    },
  });
}
