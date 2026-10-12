import { AppError, RETRY_POLICIES } from '@extension/shared';
import { db as defaultDb } from '@extension/storage';
import type { AviCopilotDb, RunRecord, RunStep, WorkflowRecord } from '@extension/storage';
import { filterExternalContent } from '../agent/messages/utils';
import { localDate } from '../workflows/engine';
import type { StepExecutor } from '../workflows/engine';
import { lookupPath, resolveTemplate, templateRefs } from '../workflows/template';
import type { ConnectorService } from './service';

/**
 * step.tool: a routine's call to a connector's tool, under the same rules as the agent's. The engine asks the
 * user before a step that is not marked read-only (an Inbox approval); a step marked read-only runs only a tool
 * the user set to run freely, so a routine cannot pass a write off as a read. Reads are retried by the engine,
 * writes never; a write cut off mid-call ends the run as "unknown outcome".
 */

export const STEP_RESULT_CHARS = 20_000;

const ONE_PLACE = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}$/;

const notAnObject = () =>
  new AppError(
    'invalid',
    'The tool step\'s arguments are not a JSON object. Write them like {"query": "{{steps.news.output}}"}.',
    { retryable: false },
  );

/** What the step's places may name: earlier steps' outputs, the run and the workflow, as the engine fills them. */
export async function stepScope(
  run: RunRecord,
  workflow: WorkflowRecord,
  database: AviCopilotDb = defaultDb,
): Promise<Record<string, unknown>> {
  const steps: RunStep[] = await database.runSteps.where('runId').equals(run.id).toArray();
  return {
    steps: Object.fromEntries(
      steps.filter(step => step.status === 'succeeded').map(step => [step.nodeId, { output: step.output }]),
    ),
    run: {
      date: localDate(run.startedAt),
      startedAt: new Date(run.startedAt).toISOString(),
      trigger: run.trigger.type,
    },
    workflow: { name: workflow.name },
  };
}

/**
 * Fills the places inside the arguments' values, one value at a time: what an earlier step produced becomes the
 * value of a field and nothing else, so it can never add a field or change another (as pasting it into the JSON
 * text would). A value that is exactly one place takes the output as it is (a list stays a list).
 */
export function fillArgs(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = ONE_PLACE.exec(value);
    if (whole) return lookupPath(scope, whole[1].split('.')) ?? '';
    return templateRefs(value).length ? resolveTemplate(value, scope) : value;
  }
  if (Array.isArray(value)) return value.map(item => fillArgs(item, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fillArgs(inner, scope)]));
  }
  return value;
}

/** The step's arguments: its JSON text, with places filled from the run. */
export async function toolStepArgs(
  template: string,
  scopeOf: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const text = template.trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw notAnObject();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw notAnObject();
  if (!templateRefs(text).length) return parsed as Record<string, unknown>;
  return fillArgs(parsed, await scopeOf()) as Record<string, unknown>;
}

export function toolStepExecutor(service: ConnectorService, database: AviCopilotDb = defaultDb): StepExecutor {
  return {
    // The engine retries only steps that are not side effects, i.e. read-only ones
    retry: RETRY_POLICIES.connectorRead,
    // A tool's answer comes from outside
    taints: true,
    execute: async ({ node, run, workflow, signal }) => {
      if (node.type !== 'step.tool') throw new AppError('invalid', 'Not a tool step.', { retryable: false });
      const args = await toolStepArgs(node.args, () => stepScope(run, workflow, database));
      const scope = {
        workspaceId: run.workspaceId ?? workflow.workspaceId ?? null,
        agentId: run.agentId ?? workflow.agentId ?? null,
      };
      const prepared = await service.prepare(scope, node.connector, node.tool, args);
      if ('refused' in prepared) throw new AppError('forbidden', prepared.refused, { retryable: false });
      const name = `${prepared.connector.name} › ${prepared.fingerprint.tool}`;
      if (node.readOnly && prepared.policy !== 'read') {
        throw new AppError(
          'forbidden',
          `"${node.label}" is marked as only reading, but ${name} asks the user first, so it was not run. Turn off "only reads" for this step so the routine asks before it runs it.`,
          { retryable: false },
        );
      }
      // A step that is not read-only gets here only after the user's click on its approval
      const result = await service.invoke(prepared, { signal, retry: false, maxChars: STEP_RESULT_CHARS });
      if (result.isError) {
        const said = filterExternalContent(result.text).replace(/\s+/g, ' ').slice(0, 300);
        throw new AppError('invalid', `${name} reported an error: ${said}`, { retryable: false });
      }
      return { kind: 'done', output: result.text, tainted: true };
    },
  };
}
