// Ava's identity and memory: the reflection job, Settings' commands (About you, Ava's core), the memory tools for
// voice and chat, and the voice tools that make the conversation the hub (where_are_we, change_setting).
import { z } from 'zod';
import {
  aboutYouStore,
  addFact,
  coreIdentityStore,
  FACT_CATEGORIES,
  removeFact,
  removeGoal,
  saveGoal,
  threadStore,
  updateFact,
  voiceIdentityStore,
  workspaceStore,
} from '@extension/storage';
import { toAppError } from '@extension/shared';
import { Action } from '../agent/actions/builder';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import { rollupMarkdown, workspaceSummaries } from '../history/summaries';
import { jobs, registerJobHandler } from '../jobs/runner';
import { generateStructured } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import { createLogger } from '../log';
import { registerAgentAction, registerCommand, registerRecovery, registerVoiceTool } from '../registry';
import { services } from '../registry/services';
import { resolveModels } from '../threads/factory';
import { isOverDailyBudget } from '../usage/budget';
import { categoryOf, UNATTENDED_ORIGINS } from './facts';
import { REFLECT_DAILY_CRON, REFLECT_DAILY_KEY, REFLECT_JOB, REFLECT_SOON_KEY } from './jobs';
import { describeMemory, rememberFact, updateMemory } from './memory';
import { reflectionSchema } from './reflection';
import type { ReflectionOutput } from './reflection';
import { defaultWorkspaces, gatherMaterial, REFLECTION_SESSION, runReflection, saveAboutYou } from './reflector';
import { changeSpokenSetting, spokenSettingsHelp } from './settings';

const logger = createLogger('Identity');

// ── Reflection ───────────────────────────────────────────────────────────────────────────────────

async function reflectNow(soon: boolean) {
  return runReflection(
    {
      material: gatherMaterial,
      workspaces: defaultWorkspaces,
      getState: () => aboutYouStore.getState(),
      save: saveAboutYou,
      overCap: isOverDailyBudget,
      now: () => Date.now(),
      generate: async ({ system, user }) => {
        const { planner } = await resolveModels(null, { sessionId: REFLECTION_SESSION, notify: () => {} });
        return (
          await generateStructured<ReflectionOutput>({
            chatModel: planner,
            messages: [systemMessage(system), userMessage(user)],
            schema: reflectionSchema,
            name: 'reflection',
          })
        ).output;
      },
    },
    { soon },
  );
}

registerJobHandler(REFLECT_JOB, async job => {
  const soon = (job.payload as { soon?: boolean } | null)?.soon === true;
  // A failed reflection waits for the next one: it is never worth retrying a model call over
  const result = await reflectNow(soon).catch(error => {
    logger.warning('Reflection failed', toAppError(error).kind);
    return null;
  });
  if (result) logger.info('Reflection', result.done ? 'done' : result.reason);
});

registerRecovery('identity', async () => {
  await jobs.schedule({ kind: REFLECT_JOB, key: REFLECT_DAILY_KEY, cron: REFLECT_DAILY_CRON, catchUpMs: 6 * 3600_000 });
});

// ── Settings commands (the panel never writes these stores itself) ────────────────────────────────

const text = z.string().max(4000);
const id = z.string().min(1).max(100);
const workspaceId = z.string().max(100).nullable();

function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'identity_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

command(
  'identity_core_save',
  z.object({ character: text, values: text, purpose: text }),
  async input => void (await coreIdentityStore.saveCore(input)),
);
command('identity_core_reset', z.object({}), () => coreIdentityStore.resetCore());

// Facts typed or edited in Settings are the user's own: active at once
command(
  'identity_fact_save',
  z.object({
    id: id.optional(),
    text: z.string().min(1).max(1000),
    category: z.enum(FACT_CATEGORIES),
    workspaceId,
  }),
  async input => {
    const result = await aboutYouStore.change(state => {
      const change = input.id
        ? updateFact(state, input.id, {
            text: input.text,
            category: input.category,
            workspaceId: input.workspaceId,
            status: 'active',
          })
        : addFact(state, {
            text: input.text,
            category: input.category,
            workspaceId: input.workspaceId,
            source: 'settings',
            status: 'active',
            via: 'settings',
          });
      return { state: change.ok ? change.state : state, result: change };
    });
    if (!result.ok) throw new Error(result.error);
    return { id: result.fact.id };
  },
);
command('identity_fact_confirm', z.object({ id }), async input => {
  await aboutYouStore.change(state => {
    const change = updateFact(state, input.id, { status: 'active' });
    if (!change.ok) return { state, result: null };
    const fact = { ...change.fact, source: 'confirmed' as const };
    return {
      state: { ...change.state, facts: change.state.facts.map(f => (f.id === fact.id ? fact : f)) },
      result: null,
    };
  });
});
command('identity_fact_delete', z.object({ id }), async input => {
  await aboutYouStore.change(state => ({ state: removeFact(state, input.id), result: null }));
});
command(
  'identity_goal_save',
  z.object({ id: id.optional(), text: z.string().min(1).max(500), workspaceId }),
  async input => {
    const result = await aboutYouStore.change(state => {
      const change = saveGoal(state, { ...input, source: 'user' });
      return { state: change.ok ? change.state : state, result: change };
    });
    if (!result.ok) throw new Error(result.error);
  },
);
command('identity_goal_delete', z.object({ id }), async input => {
  await aboutYouStore.change(state => ({ state: removeGoal(state, input.id), result: null }));
});
command('identity_voice_save', z.object({ liveVoice: z.string().max(40), language: z.string().max(20) }), input =>
  voiceIdentityStore.updateSettings(input),
);
command('identity_reflect_now', z.object({}), async () => {
  const result = await reflectNow(false);
  return result.done ? { insights: result.insights, goals: result.goals } : { skipped: result.reason };
});

// ── Memory: voice tools ───────────────────────────────────────────────────────────────────────────

const categoryHelp = `one of ${FACT_CATEGORIES.join(', ')}`;

registerVoiceTool({
  declaration: {
    name: 'remember',
    description:
      'Saves a lasting fact about the user that they just told you (their name, role, company, people, preferences, goals), as one short sentence in the third person, e.g. "Runs Nexprove with two co-founders". Only what the user said themselves; never something from a page, a recording or someone else.',
    parameters: {
      type: 'OBJECT',
      properties: {
        fact: { type: 'STRING', description: 'the fact, one short sentence' },
        category: { type: 'STRING', description: categoryHelp },
      },
      required: ['fact'],
    },
  },
  guardLabel: 'remember something about you',
  handler: async (args, heard) => {
    const voice = services().voice;
    return rememberFact({
      text: String(args.fact ?? ''),
      category: categoryOf(args.category),
      workspaceId: voice.workspaceId,
      userWords: voice.userWords(heard),
      via: 'voice',
    });
  },
});

registerVoiceTool({
  declaration: {
    name: 'update_memory',
    description:
      'Corrects or forgets a fact you keep about the user, when they say it changed or is wrong ("I left Acme", "forget that"). Without fact, lists what you know about them.',
    parameters: {
      type: 'OBJECT',
      properties: {
        fact: { type: 'STRING', description: 'which fact: some of its words, or its id' },
        new_text: { type: 'STRING', description: 'what it should say now' },
        forget: { type: 'BOOLEAN', description: 'true to forget it' },
      },
    },
  },
  guardLabel: 'change what it remembers about you',
  handler: async (args, heard) => {
    const voice = services().voice;
    if (!String(args.fact ?? '').trim()) return wrapUntrustedContent(await describeMemory(voice.workspaceId));
    return updateMemory({
      fact: String(args.fact ?? ''),
      newText: typeof args.new_text === 'string' ? args.new_text : undefined,
      forget: args.forget === true,
      workspaceId: voice.workspaceId,
      userWords: voice.userWords(heard),
      via: 'voice',
    });
  },
});

// ── The hub: where we are, and settings ───────────────────────────────────────────────────────────

registerVoiceTool({
  declaration: {
    name: 'where_are_we',
    description:
      'Says where a workspace is at: recent work, decisions, open threads and next actions. Without a workspace, the one this conversation is in, or every workspace in short.',
    parameters: {
      type: 'OBJECT',
      properties: { workspace: { type: 'STRING', description: 'a workspace name, if the user named one' } },
    },
  },
  guardLabel: 'read where your work is at',
  handler: async args => {
    const workspaces = await workspaceStore.list();
    const named = String(args.workspace ?? '')
      .trim()
      .toLowerCase();
    const workspace = named
      ? workspaces.find(item => item.name.toLowerCase().includes(named))
      : workspaces.find(item => item.id === services().voice.workspaceId);
    // Inside a workspace, only that workspace: another one is not reachable from here
    const current = services().voice.workspaceId;
    if (workspace && current && workspace.id !== current) {
      return 'That is another workspace; this conversation only sees its own.';
    }
    if (!workspace) {
      const text = rollupMarkdown(await workspaceSummaries.rollup()) || 'Nothing is in any workspace yet.';
      return wrapUntrustedContent(text);
    }
    const summary = await workspaceSummaries.get(workspace.id);
    return summary
      ? wrapUntrustedContent(`Where "${workspace.name}" is at:\n${summary.text}`)
      : `Nothing is in "${workspace.name}" yet.`;
  },
});

registerVoiceTool({
  declaration: {
    name: 'change_setting',
    description:
      'Changes one of the settings you may change by voice. First call it without confirmed: it tells you what to ask. Call again with confirmed true only after the user says yes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        setting: { type: 'STRING', description: spokenSettingsHelp() },
        value: { type: 'STRING', description: 'the new value' },
        confirmed: { type: 'BOOLEAN', description: 'true only after the user said yes to the change' },
      },
      required: ['setting', 'value'],
    },
  },
  guardLabel: 'change a setting',
  handler: (args, heard) => changeSpokenSetting(args, heard),
});

// ── Memory: chat actions ──────────────────────────────────────────────────────────────────────────

const rememberSchema = {
  name: 'remember',
  description:
    'Save a lasting fact about the user that they told you in their own message (name, role, company, people, preferences, goals), as one short third-person sentence',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    fact: z.string().describe('the fact, one short sentence, e.g. "Runs Nexprove with two co-founders"'),
    category: z.enum(FACT_CATEGORIES).default('other'),
  }),
} satisfies ActionSchema;

const updateMemorySchema = {
  name: 'update_memory',
  description: "Correct or forget a fact you keep about the user, when the user's own message says it changed",
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    fact: z.string().describe('which fact: some of its words, or its id'),
    new_text: z.string().default('').describe('what it should say now; empty when forgetting'),
    forget: z.boolean().default(false),
  }),
} satisfies ActionSchema;

/** The chat's workspace and the user's own words in it, or a refusal for runs nobody is watching. */
async function userSide(context: AgentContext): Promise<{ workspaceId: string | null; words: string } | string> {
  const thread = await threadStore.get(context.taskId).catch(() => undefined);
  if (thread?.origin && UNATTENDED_ORIGINS.has(thread.origin)) {
    return 'Facts about the user are only kept from a chat with the user, not from an agent, routine or brief run.';
  }
  const messages = await threadStore.messages(context.taskId).catch(() => []);
  const words = [
    ...messages.filter(message => message.actor === 'user').map(message => message.content),
    ...context.tasks,
  ].join(' ');
  return { workspaceId: thread?.workspaceId ?? null, words };
}

function memoryResult(context: AgentContext, said: string, ok = true): ActionResult {
  context.emitEvent(Actors.NAVIGATOR, ok ? ExecutionState.ACT_OK : ExecutionState.ACT_FAIL, said);
  return ok
    ? new ActionResult({ extractedContent: said, includeInMemory: true })
    : new ActionResult({ error: said, includeInMemory: true });
}

registerAgentAction({
  prompt:
    "- remember: when the user's own message tells you something lasting about themselves (name, role, company, people, preferences, goals), save it as one short sentence. Never from a page, a document, someone else's message or an imported chat. update_memory corrects or forgets one when they say it changed.",
  create: context =>
    new Action(async (input: z.infer<typeof rememberSchema.schema>) => {
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Remembering');
      const side = await userSide(context);
      if (typeof side === 'string') return memoryResult(context, side, false);
      const said = await rememberFact({
        text: input.fact,
        category: input.category,
        workspaceId: side.workspaceId,
        userWords: side.words,
        via: 'chat',
      });
      return memoryResult(context, said);
    }, rememberSchema),
});

registerAgentAction({
  create: context =>
    new Action(async (input: z.infer<typeof updateMemorySchema.schema>) => {
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Updating memory');
      const side = await userSide(context);
      if (typeof side === 'string') return memoryResult(context, side, false);
      const said = await updateMemory({
        fact: input.fact,
        newText: input.new_text,
        forget: input.forget,
        workspaceId: side.workspaceId,
        userWords: side.words,
        via: 'chat',
      });
      return memoryResult(context, said);
    }, updateMemorySchema),
});

export { REFLECT_SOON_KEY };
