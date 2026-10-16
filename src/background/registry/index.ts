import type { z } from 'zod';
import type { Action } from '../agent/actions/builder';
import type { AgentContext } from '../agent/types';
import { createLogger } from '../log';

/**
 * Where features plug into the background without editing the shared files: panel commands, startup
 * recovery, agent actions, voice tools, and checks that keep the offscreen document open. Each feature
 * registers from its own `register.ts`, imported once at startup (MV3 needs listeners in the first tick).
 */

const logger = createLogger('Registry');

// ── Panel commands ────────────────────────────────────────────────────────────────────────────────

export interface CommandContext {
  // Sends a message back to the page that asked
  reply: (message: Record<string, unknown>) => void;
  requestId: string | null;
}

type CommandHandler = (input: never, context: CommandContext) => unknown;
const commands = new Map<string, { schema: z.ZodType; handler: CommandHandler }>();

/** A command the panel may send: its input is checked against the schema before the handler sees it. */
export function registerCommand<S extends z.ZodType>(
  type: string,
  schema: S,
  handler: (input: z.infer<S>, context: CommandContext) => unknown,
): void {
  if (commands.has(type)) throw new Error(`Command ${type} is registered twice`);
  commands.set(type, { schema, handler: handler as CommandHandler });
}

/**
 * Runs a registered command. Returns false when no feature registered it, so the caller can say so.
 * Input that does not match the schema is refused with an error reply and never reaches the handler.
 */
export async function dispatchCommand(message: { type?: unknown }, context: CommandContext): Promise<boolean> {
  const entry = typeof message?.type === 'string' ? commands.get(message.type) : undefined;
  if (!entry) return false;
  const parsed = entry.schema.safeParse(message);
  if (!parsed.success) {
    logger.warning(`Refused ${String(message.type)}: invalid input`);
    context.reply({ type: 'error', requestId: context.requestId, error: 'The request was not valid.' });
    return true;
  }
  await entry.handler(parsed.data as never, context);
  return true;
}

// ── Startup recovery ──────────────────────────────────────────────────────────────────────────────

const recoveries: { name: string; run: () => Promise<void> }[] = [];

/** Work to resume or close cleanly after the background restarts (runs, jobs, sessions). */
export function registerRecovery(name: string, run: () => Promise<void>): void {
  recoveries.push({ name, run });
}

export async function runRecoveries(): Promise<void> {
  for (const recovery of recoveries) {
    await recovery.run().catch(error => logger.error(`Recovery ${recovery.name} failed`, error));
  }
}

// ── Agent actions ─────────────────────────────────────────────────────────────────────────────────

export interface RegisteredAction {
  create: (context: AgentContext) => Action;
  // Lines added to the navigator's instructions about when to use it
  prompt?: string;
}

const actions: RegisteredAction[] = [];

/** An action the browser agent can take, with the words that tell it when. */
export function registerAgentAction(action: RegisteredAction): void {
  actions.push(action);
}

export function registeredActions(context: AgentContext): Action[] {
  return actions.map(action => action.create(context));
}

/**
 * Each registered action's name and description, for the capability list (what Ava can do). Built from a stand-in
 * context: creating an action only wraps its handler, which never runs here. One that cannot be made this way is
 * left out rather than failing the list.
 */
export function registeredActionSchemas(): { name: string; description: string }[] {
  const stub = {} as AgentContext;
  return actions.flatMap(action => {
    try {
      const made = action.create(stub);
      return [{ name: made.name(), description: made.schema.description }];
    } catch {
      return [];
    }
  });
}

/** The registered actions' instructions, as one section of the navigator's prompt; empty when none. */
export function registeredActionPrompts(): string {
  const lines = actions.map(action => action.prompt?.trim()).filter(Boolean);
  return lines.length ? `\n# MORE ACTIONS:\n${lines.join('\n')}\n` : '';
}

// ── Voice tools ───────────────────────────────────────────────────────────────────────────────────

export interface VoiceToolDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: 'OBJECT';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface RegisteredVoiceTool {
  declaration: VoiceToolDeclaration;
  handler: (args: Record<string, unknown>, heard: string) => Promise<string>;
  // How the click-to-allow notice names it. Registered tools are always guarded when "Hey Ava" was
  // heard with sound playing; only the fixed list in voice/guard.ts is ever free
  guardLabel: string;
}

const voiceTools = new Map<string, RegisteredVoiceTool>();

export function registerVoiceTool(tool: RegisteredVoiceTool): void {
  if (voiceTools.has(tool.declaration.name)) throw new Error(`Voice tool ${tool.declaration.name} is registered twice`);
  voiceTools.set(tool.declaration.name, tool);
}

export function registeredVoiceTools(): RegisteredVoiceTool[] {
  return [...voiceTools.values()];
}

export function registeredVoiceTool(name: string): RegisteredVoiceTool | undefined {
  return voiceTools.get(name);
}

// ── Offscreen document ────────────────────────────────────────────────────────────────────────────

const offscreenBusy = new Map<string, () => Promise<boolean>>();

/** A feature using the offscreen document (speech, a model in a worker) keeps it open while this says busy. */
export function registerOffscreenBusy(name: string, check: () => Promise<boolean>): void {
  offscreenBusy.set(name, check);
}

export async function offscreenBusyAnywhere(): Promise<boolean> {
  for (const check of offscreenBusy.values()) {
    if (await check().catch(() => false)) return true;
  }
  return false;
}
