import { z } from 'zod';
import { db, threadStore } from '@extension/storage';
import type { AgentProfile } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { Action } from '../agent/actions/builder';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import { callerOf } from '../integrations/caller';
import { didNotHappen, guardOnce } from '../once/guard';
import type { OnceStart } from '../once/guard';
import { registerAgentAction, registerVoiceTool } from '../registry';
import { services } from '../registry/services';
import type { HandoffService } from './handoff';
import { isAttendedThread, resolveHandoff, trustedTask } from './handoff';
import { teamLines, teamOf } from './team-section';

/**
 * How Ava reaches the team: the chat action and voice tool hand_to_agent, and the block that tells her which
 * agents own what (in a chat's step, see teamSectionFor; in a voice conversation, in the tool's description).
 */

const intent = z.string().default('').describe('purpose of this action');

export const handToAgentSchema = {
  name: 'hand_to_agent',
  description:
    "Hand a task to the user's agent that owns its area of work (email, social posts, research, meeting follow-ups, calendar…) or to an agent by name. It runs in its own window and its answer comes back to this chat",
  schema: z.object({
    intent,
    area: z.string().default('').describe('the area of work, e.g. "email" or "research"; "" when naming the agent'),
    agent: z.string().default('').describe('the agent name, when the user named one; else ""'),
    task: z.string().describe("the task in the user's own words"),
  }),
} satisfies ActionSchema;

export const HANDOFF_PROMPT =
  "- hand_to_agent hands a task to the user's agent that owns its area (see [Your agents] in the browser state) or that the user named: pass the area or the agent and the task in the user's words. Do not do that work yourself, and do not wait for the agent: say in one line that it was handed over, and finish. Only the user's own chats can hand work over.";

function fail(context: AgentContext, message: string): ActionResult {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
  return new ActionResult({ error: message, includeInMemory: true });
}

// The agents as last read, for the voice tool's description (read when a conversation starts, so it cannot wait)
let snapshot: AgentProfile[] = [];
let refreshing: ReturnType<typeof setTimeout> | null = null;

export function refreshTeamSnapshot(): void {
  if (refreshing) return;
  refreshing = setTimeout(() => {
    refreshing = null;
    void db.agents
      .toArray()
      .then(agents => (snapshot = agents))
      .catch(() => {});
  });
}

function voiceWorkspace(): string | null {
  try {
    return services().voice.workspaceId;
  } catch {
    return null;
  }
}

const VOICE_DESCRIPTION =
  "Hands a task to the user's agent that owns its area of work (or one they name). It runs in its own window; the user hears when it is done and its answer goes in this conversation's chat. Use it whenever a request falls in an area an agent owns.";

export function registerHandoff(handoffs: HandoffService): void {
  registerAgentAction({
    prompt: HANDOFF_PROMPT,
    create: context =>
      new Action(async (input: z.infer<typeof handToAgentSchema.schema>) => {
        void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Handing it to an agent');
        const { attended } = await callerOf(context);
        if (!attended) return fail(context, 'Only a chat with the user can hand work to an agent.');
        let guard: OnceStart | null = null;
        try {
          const messages = await threadStore.messages(context.taskId);
          const userWords = messages.filter(message => message.actor === 'user').at(-1)?.content ?? '';
          // Do once: a task that was retried does not hand the same work over again without the user's click.
          // A handover that cannot be resolved is left to handOff, which says why in plain words.
          const target = resolveHandoff(await handoffs.teamFor(context.taskId), {
            area: input.area,
            agent: input.agent,
          });
          if (!('error' in target)) {
            const claim = await guardOnce(
              context,
              {
                what: 'agent.handoff',
                scope: `agent:${target.agent.id}`,
                label: `hand a task to the agent "${target.agent.name}"`,
                parts: [target.agent.id, trustedTask(input.task, userWords).task || input.task],
              },
              {
                kind: 'submit',
                intent: `Hand the task to "${target.agent.name}" again`,
                target: target.agent.name,
                fields: [{ label: 'Task', value: input.task.trim().slice(0, 300) }],
              },
            );
            if ('result' in claim) return claim.result;
            guard = claim.start;
          }
          const { agent, area } = await handoffs.handOff({
            threadId: context.taskId,
            from: 'chat',
            area: input.area,
            agent: input.agent,
            task: input.task,
            userWords,
          });
          await guard?.done('handed over');
          const text = `Handed to "${agent.name}"${area ? ` (it owns ${area})` : ''}. It works in its own window; a card in this chat shows where it is, and its answer is posted here when it ends. Tell the user that in one short line and finish now; do not do the task yourself.`;
          void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, `Handed to ${agent.name}`);
          return new ActionResult({ extractedContent: text, includeInMemory: true });
        } catch (error) {
          const problem = toAppError(error);
          // Refused before it began: nothing started, so it may be tried again
          if (didNotHappen(problem.kind)) await guard?.failed(problem.kind);
          return fail(context, problem.message);
        }
      }, handToAgentSchema),
  });

  registerVoiceTool({
    declaration: {
      name: 'hand_to_agent',
      // Read when a conversation starts: the agents of its workspace and what they own
      get description() {
        const lines = teamLines(teamOf(snapshot, voiceWorkspace()));
        return lines.length
          ? `${VOICE_DESCRIPTION} The agents and what they own:\n${lines.join('\n')}`
          : VOICE_DESCRIPTION;
      },
      parameters: {
        type: 'OBJECT',
        properties: {
          area: { type: 'STRING', description: 'the area of work, e.g. "email"; "" when naming the agent' },
          agent: { type: 'STRING', description: 'the agent name, when the user named one' },
          task: { type: 'STRING', description: "the task in the user's own words" },
        },
        required: ['task'],
      },
    },
    guardLabel: 'hand a task to one of your agents',
    async handler(args, heard) {
      try {
        const voice = services().voice;
        const threadId = voice.currentThreadId;
        const thread = threadId ? await threadStore.get(threadId) : undefined;
        if (!thread || !isAttendedThread(thread)) return 'There is no conversation to hand it over from.';
        const userWords = voice.userWords(heard);
        // Do once, as in a chat. A spoken conversation has no card to ask on, so a repeat is refused: the user
        // can say it again in the chat, where the card is
        const target = resolveHandoff(await handoffs.teamFor(thread.id), {
          area: String(args.area ?? ''),
          agent: String(args.agent ?? ''),
        });
        let guard: OnceStart | null = null;
        if (!('error' in target)) {
          const claim = await guardOnce(
            {
              taskId: thread.id,
              emitEvent: async () => {},
              confirmGate: { ask: async () => 'declined' } as unknown as AgentContext['confirmGate'],
              controller: new AbortController(),
              stop: async () => {},
            },
            {
              what: 'agent.handoff',
              scope: `agent:${target.agent.id}`,
              label: `hand a task to the agent "${target.agent.name}"`,
              parts: [target.agent.id, trustedTask(String(args.task ?? ''), userWords).task || String(args.task ?? '')],
            },
            { kind: 'submit', intent: '', target: target.agent.name, fields: [] },
          );
          if ('result' in claim) return claim.result.error ?? 'It was already handed over.';
          guard = claim.start;
        }
        let handed;
        try {
          handed = await handoffs.handOff({
            threadId: thread.id,
            from: 'voice',
            area: String(args.area ?? ''),
            agent: String(args.agent ?? ''),
            task: String(args.task ?? ''),
            userWords,
          });
        } catch (error) {
          const problem = toAppError(error);
          if (didNotHappen(problem.kind)) await guard?.failed(problem.kind);
          throw error;
        }
        await guard?.done('handed over');
        const { agent, area } = handed;
        return `Handed to "${agent.name}"${area ? `, which owns ${area}` : ''}. It works in its own window; the user will hear when it is done or needs their click. Say so in a few words.`;
      } catch (error) {
        return toAppError(error).message;
      }
    },
  });

  refreshTeamSnapshot();
  const changed = () => refreshTeamSnapshot();
  db.agents.hook('creating', changed);
  db.agents.hook('updating', changed);
  db.agents.hook('deleting', changed);
}
