import { z } from 'zod';
import { t } from '@extension/i18n';
import { threadStore } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { Action } from '../agent/actions/builder';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { RegisteredVoiceTool } from '../registry';
import { ownWords } from '../identity/facts';
import { callerOf } from './caller';
import { isSetupTarget, setupTargetFrom } from './setup';
import type { ConnectionSetup, SetupStep } from './setup';

/**
 * set_up_connection: the chat's (and voice's) way into the guided setup. The action does the parts it can — adds
 * the connector, opens the sign-in or developer page — and hands the agent the words for the user. The agent
 * never types into those pages or presses their buttons: the tabs are not bound to its chat.
 */

export const setUpConnectionSchema = {
  name: 'set_up_connection',
  description:
    'Set up a connection for the user, step by step: Obsidian, a connector (GitHub, Linear, Notion, Slack, Gmail, Google Calendar, Google Drive, or any MCP server by its address) or a model key. Opens the pages needed and says what the user does next',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    service: z
      .string()
      .describe(
        'what to set up: obsidian, models, github, linear, notion, slack, gmail, google_calendar, google_drive, or custom',
      ),
    url: z.string().default('').describe('a custom MCP server address, only for custom'),
    provider: z.string().default('').describe('for models: gemini, openai, anthropic, openrouter, groq or deepseek'),
  }),
} satisfies ActionSchema;

export const SET_UP_CONNECTION_PROMPT = `- set_up_connection sets up what the user asks to connect or set up (Obsidian, a connector, a custom MCP server by its address, or a model key). It opens the pages needed and returns what to tell the user: tell them that, in your own words, and finish with done. When they say they are done, call it again to carry on from where it stands. Never type into, click on or read the sign-in, consent or developer pages it opens: the user logs in and approves there. Never ask for a password, token, key or client secret in the chat: those go into the panel's fields.`;

/** The words the agent gets: the step, what to tell the user, and what it must not do. */
export function describeStep(step: SetupStep): string {
  const lines = [`Setup of ${step.target}: ${step.done ? 'finished' : `waiting (${step.stage})`}.`];
  lines.push(`Tell the user: ${step.say}`);
  if (step.opened.length) lines.push(`Opened for the user: ${step.opened.join(', ')}. Leave those tabs to them.`);
  if (!step.done) lines.push('When they say they are done, call set_up_connection again with the same service.');
  return lines.join('\n');
}

/** An address in one form, so the one checked is the one used: "https://host/path", no trailing slash. */
export function normalAddress(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * The address, in its one form, when the user typed exactly it in the chat themselves (not a page, a file or a
 * tool result); else null.
 */
export async function userTyped(threadId: string, url: string): Promise<string | null> {
  const wanted = normalAddress(url);
  if (!wanted) return null;
  const messages = await threadStore.messages(threadId).catch(() => []);
  const typed = messages
    .filter(message => message.actor === 'user')
    .flatMap(message => ownWords(message.content).match(/https?:\/\/[^\s"'<>()]+/gi) ?? [])
    .map(address => normalAddress(address.replace(/[.,;:!?]+$/, '')));
  return typed.includes(wanted) ? wanted : null;
}

export async function runSetUpConnection(
  setup: ConnectionSetup,
  context: AgentContext,
  input: z.infer<typeof setUpConnectionSchema.schema>,
): Promise<ActionResult> {
  const named = input.service.trim().toLowerCase().replace(/\s+/g, '_');
  const target = isSetupTarget(named) ? named : setupTargetFrom(`${input.service} ${input.url}`);
  if (!target) {
    const message = `I can set up obsidian, models, github, linear, notion, slack, gmail, google_calendar, google_drive, or a custom server by its address; "${input.service}" is none of them.`;
    void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
    return new ActionResult({ error: message, includeInMemory: true });
  }
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || t('conn_setup_act_start'));
  try {
    const { scope, attended } = await callerOf(context);
    // Adding a connector and opening its sign-in is for the user's own chats, on their own words
    if (!attended) throw new Error(t('conn_setup_unattended'));
    const url = target === 'custom' ? await userTyped(context.taskId, input.url) : undefined;
    if (url === null) throw new Error(t('conn_setup_urlNotTyped'));
    const step = await setup.advance({
      target,
      url,
      provider: input.provider.trim().toLowerCase() || undefined,
      workspaceId: scope.workspaceId,
      threadId: context.taskId,
    });
    void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, step.say);
    return new ActionResult({ extractedContent: describeStep(step), includeInMemory: true });
  } catch (thrown) {
    const message = toAppError(thrown).message;
    void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
    return new ActionResult({ error: message, includeInMemory: true });
  }
}

export function setUpConnectionAgentAction(setup: ConnectionSetup) {
  return {
    prompt: SET_UP_CONNECTION_PROMPT,
    create: (context: AgentContext) =>
      new Action(
        (input: z.infer<typeof setUpConnectionSchema.schema>) => runSetUpConnection(setup, context, input),
        setUpConnectionSchema,
      ),
  };
}

/** The same, by voice: "Ava, connect my Linear". Returns what Ava says. */
export function setUpConnectionVoiceTool(setup: ConnectionSetup): RegisteredVoiceTool {
  return {
    declaration: {
      name: 'set_up_connection',
      description:
        'Set up a connection the user asks for: obsidian, models, github, linear, notion, slack, gmail, google_calendar or google_drive. Opens the pages needed and returns what to tell the user; call again when they say they are done.',
      parameters: {
        type: 'OBJECT',
        properties: { service: { type: 'STRING', description: 'what to set up, e.g. "linear" or "obsidian"' } },
        required: ['service'],
      },
    },
    guardLabel: 'Set up a connection',
    handler: async args => {
      const words = String(args.service ?? '');
      const named = words.trim().toLowerCase().replace(/\s+/g, '_');
      const target = isSetupTarget(named) ? named : setupTargetFrom(words);
      if (!target || target === 'custom')
        return 'Say which one to set up: Obsidian, a model key, or a connector by name.';
      return (await setup.advance({ target })).say;
    },
  };
}
