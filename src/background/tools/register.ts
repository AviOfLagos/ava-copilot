// Chat actions for the read tools that used to exist only in voice: the calendar, the morning brief, the Inbox,
// the workspaces and the connectors. Each reuses the voice tool's own answer, so the two never say different things.
// All five only read, so none asks first; what they return comes from invites, chats and pages, so it is marked as
// untrusted data like the voice tools' answers.
import { z } from 'zod';
import { threadStore } from '@extension/storage';
import { Action } from '../agent/actions/builder';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import { scheduleText } from '../calendar/schedule';
import { listConnectors, listWorkspaces } from '../capabilities/tools';
import { inboxSummaryText } from '../inbox/voice';
import { registerAgentAction } from '../registry';
import { services } from '../registry/services';

const intent = z.string().default('').describe('purpose of this action');

const getScheduleSchema = {
  name: 'get_schedule',
  description:
    "List the user's calendar events for the coming hours, from the calendar connected in settings. Use it for anything about their day or meetings",
  schema: z.object({
    intent,
    hours: z.number().int().min(1).max(168).optional().describe('how many hours ahead; 24 if left out'),
  }),
} satisfies ActionSchema;

const getBriefSchema = {
  name: 'get_brief',
  description:
    "Get today's morning brief: the day's calendar, what waits on the user, open actions by workspace, and the top priorities. Makes it if there is none yet",
  schema: z.object({ intent }),
} satisfies ActionSchema;

const readInboxSchema = {
  name: 'read_inbox',
  description:
    "Read the user's Inbox: how many items are waiting, including approvals, and the most important by title. Never reads a message body",
  schema: z.object({ intent }),
} satisfies ActionSchema;

const listWorkspacesSchema = {
  name: 'list_workspaces',
  description: "List the user's workspaces and which one is the default and which one this chat is in",
  schema: z.object({ intent }),
} satisfies ActionSchema;

const listConnectorsSchema = {
  name: 'list_connectors',
  description: 'List the connectors (Slack, GitHub, Notion…) and whether each is connected or needs a sign-in',
  schema: z.object({ intent }),
} satisfies ActionSchema;

/** Runs one read and hands the model its text; a failure is said, not thrown. */
async function read(context: AgentContext, start: string, answer: () => Promise<string>): Promise<ActionResult> {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, start);
  try {
    const text = await answer();
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, text.split('\n')[0].slice(0, 200));
    return new ActionResult({ extractedContent: text, includeInMemory: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
    return new ActionResult({ error: message, includeInMemory: true });
  }
}

registerAgentAction({
  prompt:
    '- get_schedule, get_brief, read_inbox, list_workspaces, list_connectors: read-only. For "what is on my calendar?", "what is in my brief or Inbox?", "what workspaces or connectors do I have?" call the one that matches and answer from it; never browse a calendar page for this.',
  create: (context: AgentContext) =>
    new Action(
      async (input: z.infer<typeof getScheduleSchema.schema>) =>
        read(context, input.intent || 'Reading the calendar', () => scheduleText(services().calendar, input.hours)),
      getScheduleSchema,
    ),
});

registerAgentAction({
  create: (context: AgentContext) =>
    new Action(
      async () =>
        read(context, 'Reading the morning brief', async () =>
          // Built from invites, chats and pages: data, never instructions
          wrapUntrustedContent(await services().brief.today()),
        ),
      getBriefSchema,
    ),
});

registerAgentAction({
  create: (context: AgentContext) =>
    new Action(
      async () => read(context, 'Reading the Inbox', async () => wrapUntrustedContent(await inboxSummaryText())),
      readInboxSchema,
    ),
});

registerAgentAction({
  create: (context: AgentContext) =>
    new Action(
      async () =>
        read(context, 'Listing the workspaces', async () => {
          const thread = await threadStore.get(context.taskId).catch(() => undefined);
          return listWorkspaces(thread?.workspaceId ?? null, true);
        }),
      listWorkspacesSchema,
    ),
});

registerAgentAction({
  create: (context: AgentContext) =>
    new Action(async () => read(context, 'Listing the connectors', () => listConnectors(true)), listConnectorsSchema),
});
