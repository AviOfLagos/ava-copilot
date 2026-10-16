import { z } from 'zod';
import { toAppError } from '@extension/shared';
import type { AgentProfileFields } from '@extension/storage';
import { createLogger } from '../log';
import { registerCommand } from '../registry';
import { AGENT_ROLES } from './profile';
import type { AgentService } from './service';
import { AGENT_TEMPLATE_IDS, TEAM_TEMPLATE_IDS } from './templates';

/** The panel's commands for agents. Each replies `agents_ok` with its result, or an error sentence. */

const logger = createLogger('Agents');

const id = z.string().min(1).max(100);

// A hand edit: only the fields given change; the whole profile is checked again before it is kept
export const fieldsPatchSchema = z
  .object({
    name: z.string().max(60),
    avatar: z.string().max(8),
    instructions: z.string().max(4000),
    startUrl: z.string().max(2000).nullable(),
    domains: z.array(z.string().max(300)).max(30),
    modelRole: z.enum(AGENT_ROLES),
    workspaceId: z.string().max(100).nullable(),
    triggers: z.array(z.record(z.string(), z.unknown())).max(8),
    publishes: z.array(z.string().max(64)).max(10),
    subscribes: z.array(z.string().max(64)).max(10),
    skills: z.array(z.string().max(64)).max(3),
    budget: z.object({
      dailyUsd: z.number().min(0).max(100).nullable(),
      maxStepsPerRun: z.number().int().min(1).max(200),
      runsPerDay: z.number().int().min(1).max(288),
    }),
    inboxResults: z.boolean(),
    owns: z.array(z.string().max(40)).max(6),
    charter: z.string().max(200).nullable(),
  })
  .partial()
  .strict();

export function registerAgentCommands(service: AgentService): void {
  const command = <S extends z.ZodType>(
    type: string,
    schema: S,
    run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
  ) =>
    registerCommand(type, schema, async (input, context) => {
      try {
        const result = (await run(input)) ?? {};
        context.reply({ type: 'agents_ok', requestId: context.requestId, ...result });
      } catch (error) {
        const appError = toAppError(error);
        logger.warning(`${type} failed (${appError.kind})`);
        context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
      }
    });

  command(
    'agents_template',
    z.object({ template: z.enum(AGENT_TEMPLATE_IDS), workspaceId: z.string().max(100).nullable().optional() }),
    async input => ({ id: (await service.fromTemplate(input.template, input.workspaceId ?? null)).id }),
  );
  // "Set up my team": a draft for each starter the user ticked
  command(
    'agents_team_setup',
    z.object({
      templates: z.array(z.enum(TEAM_TEMPLATE_IDS)).min(1).max(TEAM_TEMPLATE_IDS.length),
      workspaceId: z.string().max(100).nullable().optional(),
    }),
    async input => ({
      ids: (await service.setUpTeam(input.templates, input.workspaceId ?? null)).map(agent => agent.id),
    }),
  );
  command('agents_confirm', z.object({ id }), async input => {
    const agent = await service.confirm(input.id);
    return { id: agent.id, version: agent.version };
  });
  command('agents_discard', z.object({ id }), input => service.discard(input.id));
  command('agents_update', z.object({ id, fields: fieldsPatchSchema }), async input => {
    await service.update(input.id, input.fields as Partial<AgentProfileFields>);
  });
  command('agents_pause', z.object({ id, paused: z.boolean() }), async input => {
    await service.setEnabled(input.id, !input.paused);
  });
  command('agents_delete', z.object({ id }), input => service.remove(input.id));
  command('agents_run', z.object({ id }), async input => {
    const run = await service.requestRun(input.id, {
      trigger: { type: 'manual', detail: 'panel' },
      attended: true,
      tainted: false,
    });
    return { runId: run.id };
  });
  command('agents_cancel_run', z.object({ runId: id }), input => service.cancelRun(input.runId));
  command('agents_tabs', z.object({ id }), async input => ({ tabs: await service.tabsOf(input.id) }));
  command('agents_focus_tab', z.object({ tabId: z.number().int().nonnegative() }), input =>
    service.focusTab(input.tabId),
  );
}
