import { db } from '@extension/storage';
import type { WorkflowRecord } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { connectorService } from '../integrations/instance';
import { toolCatalogueSectionFor } from '../integrations/section';
import { generateStructured } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import { registerVoiceTool } from '../registry';
import { services } from '../registry/services';
import { findWorkflow, outline, runResult, workflowLine } from './actions';
import { authoredSpecSchema, authorSpec } from './authoring';
import type { AuthoredSpec } from './authoring';
import { workflowModel } from './models';
import type { WorkflowService } from './service';
import { userTimezone } from './service';
import { parseSpec } from './spec';
import type { WorkflowSpec } from './spec';
import { isMeetingLinksRequest, meetingLinks } from './templates';

/**
 * Workflows by voice: draft one from the user's words, change one, run one by name, or hear the list. All are
 * guarded like every registered tool. Drafting goes through the same authoring as chat (a separate structured
 * call, never the voice model's own words), and a draft never runs before the user's click in Workflows.
 */

/**
 * The routine for a request in the user's words, spoken or typed in Workflows: the meeting-links template for that
 * request, else the authoring call (its usage counted under `sessionId`).
 */
export async function authorFromWords(request: string, current: WorkflowSpec | null, sessionId: string) {
  if (!current && isMeetingLinksRequest(request)) return { ok: true as const, spec: meetingLinks() };
  const chatModel = await workflowModel('smart', sessionId);
  return authorSpec({
    request,
    current,
    timezone: userTimezone(),
    tools: await toolCatalogueSectionFor(connectorService, { taskId: sessionId }),
    generate: async ({ system, user }) =>
      (
        await generateStructured<AuthoredSpec>({
          chatModel,
          messages: [systemMessage(system), userMessage(user)],
          schema: authoredSpecSchema,
          name: 'workflow',
        })
      ).output,
  });
}

/** The workflows this conversation may see: its workspace's and those in none (all, outside a workspace). */
async function visible(): Promise<WorkflowRecord[]> {
  const all = await db.workflows.toArray();
  const workspaceId = services().voice.workspaceId;
  return workspaceId ? all.filter(item => !item.workspaceId || item.workspaceId === workspaceId) : all;
}

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
      name: 'create_workflow',
      description:
        'Drafts a routine that runs on its own from the user\'s words: on a schedule, or whenever a page or event shows up (e.g. "whenever a Zoom, Meet or calendar link opens, offer to join and take notes"). It is only a draft until the user clicks Create in Workflows.',
      parameters: {
        type: 'OBJECT',
        properties: { request: { type: 'STRING', description: "the user's request, in their words, in full" } },
        required: ['request'],
      },
    },
    guardLabel: 'draft a workflow',
    async handler(args) {
      const request = String(args.request ?? '').trim();
      if (!request) return 'No request was given.';
      try {
        const result = await authorFromWords(request, null, services().voice.currentThreadId ?? 'voice');
        if (!result.ok) return result.error;
        const workflow = await service.saveDraft({
          spec: result.spec,
          request,
          workspaceId: services().voice.workspaceId,
        });
        return `Drafted "${workflow.name}": ${outline(result.spec)}. It is only a draft: tell the user to open Workflows, check it and click Create. Nothing runs before that.`;
      } catch (error) {
        return `Could not draft it: ${toAppError(error).message}`;
      }
    },
  });

  registerVoiceTool({
    declaration: {
      name: 'update_workflow',
      description:
        'Changes one of the user\'s workflows as they ask ("also add GitHub trending"); the change waits for their click on Apply in Workflows.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'the workflow name as the user said it' },
          change: { type: 'STRING', description: 'the change, in their words' },
        },
        required: ['name', 'change'],
      },
    },
    guardLabel: 'change one of your workflows',
    async handler(args) {
      const workflow = findWorkflow(await visible(), String(args.name ?? ''));
      if (!workflow) return `There is no workflow called "${String(args.name ?? '')}".`;
      const current = parseSpec(workflow.draft?.spec) ?? parseSpec(workflow.spec);
      try {
        const change = String(args.change ?? '').trim();
        const result = await authorFromWords(change, current, services().voice.currentThreadId ?? 'voice');
        if (!result.ok) return result.error;
        await service.saveDraft({ workflowId: workflow.id, spec: result.spec, request: change });
        return `Drafted the change to "${workflow.name}": ${outline(result.spec)}. Tell the user to check it in Workflows and click ${workflow.status === 'draft' ? 'Create' : 'Apply'}.`;
      } catch (error) {
        return `Could not change it: ${toAppError(error).message}`;
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
