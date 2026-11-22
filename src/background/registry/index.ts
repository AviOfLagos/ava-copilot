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

/**
 * Runs a command that came as a one-off `chrome.runtime.sendMessage` and answers it exactly once, on every path:
 * the handler's reply, an error when it throws or the command is unknown, and a plain `done` when it finished
 * without replying. A listener that returns true and never answers is what Chrome reports to the sender as "the
 * message channel closed before a response was received". Return its result from the listener.
 */
export function answerOneOff(message: { type?: unknown; requestId?: unknown }, sendResponse: (reply: unknown) => void) {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : null;
  let answered = false;
  const reply = (answer: Record<string, unknown>) => {
    if (answered) return;
    answered = true;
    try {
      sendResponse(answer);
    } catch {
      // The page that asked closed before the answer came
    }
  };
  dispatchCommand(message, { reply, requestId }).then(
    handled => reply(handled ? { type: 'done', requestId } : { type: 'error', requestId, error: 'Unknown request.' }),
    error => {
      logger.warning(`Command ${String(message?.type)} failed`, error);
      reply({ type: 'error', requestId, error: error instanceof Error ? error.message : String(error) });
    },
  );
  return true as const;
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
 * Builds every registered action, and says which ones could not be built instead of leaving them out. The list of
 * what Ava can do skips an action that throws (see `registeredActionSchemas`); the tool inventory test uses this so
 * that such an action fails a test rather than vanishing.
 */
export function buildRegisteredActionsStrict(context: AgentContext): { actions: Action[]; failures: string[] } {
  const built: Action[] = [];
  const failures: string[] = [];
  actions.forEach((action, index) => {
    try {
      built.push(action.create(context));
    } catch (error) {
      failures.push(`registered action #${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { actions: built, failures };
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
