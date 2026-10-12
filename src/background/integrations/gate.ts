import type { ConfirmField, ConfirmRequest, ConnectorRecord, ToolFingerprint } from '@extension/storage';
import { Actors, ExecutionState } from '../agent/event/types';
import type { AgentContext } from '../agent/types';
import { classifyLabel } from '../gate/classify';
import type { GateAnswer } from '../gate/confirmGate';

/**
 * The confirm gate for a connector's tool. A page action is reviewed from the page (gate/review.ts); a tool
 * call has no page, so it is reviewed from what will be sent: which connector, which tool, every argument. The
 * user sees exactly the call that runs, and nothing runs without their click. When the user declines, the task
 * stops, as for a page action, so the agent cannot look for another way to do the same thing.
 */

const MAX_FIELDS = 20;
const FIELD_CHARS = 2000;

export interface ToolCallReview {
  connector: Pick<ConnectorRecord, 'name' | 'url'>;
  tool: Pick<ToolFingerprint, 'tool' | 'title' | 'annotations'>;
  args: Record<string, unknown>;
  intent: string;
}

/**
 * The card's kind. The gate's types have no kind for a tool yet: the proposed one is 'tool' (title "Run a
 * connector tool"; see the WS4 section in docs/task.md). Until it exists, the commit kind the tool's name
 * suggests stands in, so today's card shows it: send_message → "Send a message", delete_page → "Delete".
 */
export function confirmKindFor(tool: Pick<ToolFingerprint, 'tool' | 'title' | 'annotations'>): ConfirmRequest['kind'] {
  const words = `${tool.tool.replace(/[_\-.]+/g, ' ')} ${tool.title ?? ''}`;
  return classifyLabel(words) ?? (tool.annotations?.destructiveHint === true ? 'delete' : 'submit');
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/** One field per argument, as it will be sent. */
export function argumentFields(args: Record<string, unknown>): ConfirmField[] {
  const entries = Object.entries(args);
  const fields = entries.slice(0, MAX_FIELDS).map(([label, value]) => {
    const text = valueText(value);
    return { label, value: text.length > FIELD_CHARS ? `${text.slice(0, FIELD_CHARS)}…` : text };
  });
  if (entries.length > MAX_FIELDS) {
    fields.push({ label: '…', value: `${entries.length - MAX_FIELDS} more arguments` });
  }
  return fields;
}

/** The request the confirm card shows for a tool call. */
export function toolCallRequest(context: Pick<AgentContext, 'taskId'>, review: ToolCallReview): ConfirmRequest {
  return {
    id: crypto.randomUUID(),
    taskId: context.taskId,
    mode: 'commit',
    kind: confirmKindFor(review.tool),
    intent: review.intent,
    target: `${review.connector.name} › ${review.tool.title || review.tool.tool}`,
    pageTitle: review.connector.name,
    pageUrl: review.connector.url ?? '',
    fields: argumentFields(review.args),
    // The server's own description is not shown here: it does not get a voice on the card that approves it
    context: '',
  };
}

/**
 * Shows the confirm card for a tool call and waits for the user's answer.
 *
 * @returns 'approved', 'declined', or 'cancelled' when the task was stopped while it waited
 */
export async function reviewToolCall(context: AgentContext, review: ToolCallReview): Promise<GateAnswer> {
  const request = toolCallRequest(context, review);
  return context.confirmGate.ask(
    request,
    shown => context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(shown)),
    context.controller.signal,
  );
}
