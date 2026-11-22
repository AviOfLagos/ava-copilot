import { t } from '@extension/i18n';
import { canAllowAlways, permissionRulesStore, toolScope } from '@extension/storage';
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
  connector: Pick<ConnectorRecord, 'name' | 'url'> & Partial<Pick<ConnectorRecord, 'id'>>;
  tool: Pick<ToolFingerprint, 'tool' | 'title' | 'annotations'> & Partial<Pick<ToolFingerprint, 'hash'>>;
  args: Record<string, unknown>;
  intent: string;
  // Set when this call, or a cut-off one to the same tool, already exists in the task: the card says so
  repeat?: ConfirmRequest['repeat'];
}

/**
 * The card's kind: the commit kind the tool's name suggests (send_message → "Send a message", delete_page →
 * "Delete"), else "Run a connector tool".
 */
export function confirmKindFor(tool: Pick<ToolFingerprint, 'tool' | 'title' | 'annotations'>): ConfirmRequest['kind'] {
  const words = `${tool.tool.replace(/[_\-.]+/g, ' ')} ${tool.title ?? ''}`;
  return classifyLabel(words) ?? (tool.annotations?.destructiveHint === true ? 'delete' : 'tool');
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
  const kind = confirmKindFor(review.tool);
  const target = `${review.connector.name} › ${review.tool.title || review.tool.tool}`;
  const scope = ruleScope(review);
  // A tool that deletes, pays or grants access is asked about every time, and so is a repeat
  const always = !!scope && !review.repeat && canAllowAlways(kind);
  return {
    id: crypto.randomUUID(),
    taskId: context.taskId,
    mode: 'commit',
    kind,
    intent: review.intent,
    target,
    ...(always ? { always: { kind: 'tool' as const, scope, label: t('gate_rule_toolLabel', [target]) } } : {}),
    pageTitle: review.connector.name,
    pageUrl: review.connector.url ?? '',
    fields: argumentFields(review.args),
    // The server's own description is not shown here: it does not get a voice on the card that approves it
    context: '',
    ...(review.repeat ? { repeat: review.repeat } : {}),
  };
}

/** The place a rule for this tool covers: the connector, the tool, and the tool as it is now. */
function ruleScope(review: ToolCallReview): string {
  return review.connector.id && review.tool.hash
    ? toolScope(review.connector.id, review.tool.tool, review.tool.hash)
    : '';
}

/**
 * Shows the confirm card for a tool call and waits for the user's answer. A tool the user allowed every time
 * runs without the card, unless the call repeats one already made.
 *
 * @returns 'approved', 'declined', or 'cancelled' when the task was stopped while it waited
 */
export async function reviewToolCall(context: AgentContext, review: ToolCallReview): Promise<GateAnswer> {
  const scope = ruleScope(review);
  const kind = confirmKindFor(review.tool);
  if (scope && !review.repeat && canAllowAlways(kind)) {
    const rule = await permissionRulesStore.find('tool', scope).catch(() => null);
    if (rule) {
      await permissionRulesStore.used(rule.id).catch(() => undefined);
      await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, t('gate_allowedByRule', [rule.label]));
      return 'approved';
    }
  }
  const request = toolCallRequest(context, review);
  const answer = await context.confirmGate.ask(
    request,
    shown => context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(shown)),
    context.controller.signal,
  );
  if (answer === 'approved' && request.always && context.confirmGate.takeAlways(request.id)) {
    await permissionRulesStore.allow(request.always).catch(() => null);
  }
  return answer;
}
