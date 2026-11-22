import { canAllowAlways, permissionRulesStore, WORKFLOW_RULE_NODE_TYPES, workflowScope } from '@extension/storage';
import type { RuleCandidate } from '@extension/storage';
import type { WorkflowNode } from './spec';

/**
 * "Allow every time" for a routine's step in the Inbox. Only a step that starts an agent may get one (see
 * WORKFLOW_RULE_NODE_TYPES), and never on a run that read outside content: the caller checks that.
 */

async function hashOf(node: WorkflowNode): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(node));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Whether the Inbox card for this step offers "Allow every time". */
export const offersRule = (node: WorkflowNode, tainted: boolean): boolean =>
  !tainted && WORKFLOW_RULE_NODE_TYPES.includes(node.type);

/** The rule "Allow every time" would save for this step: this routine, this step, as it is now. */
export async function ruleFor(workflowId: string, workflowName: string, node: WorkflowNode): Promise<RuleCandidate> {
  return {
    kind: 'workflow',
    scope: workflowScope(workflowId, node.id, await hashOf(node)),
    label: `${workflowName}: ${node.label}`,
  };
}

/** The saved rule that lets this step run without a click, counted as used; null when there is none. */
export async function allowingRule(workflowId: string, node: WorkflowNode): Promise<string | null> {
  if (!WORKFLOW_RULE_NODE_TYPES.includes(node.type)) return null;
  const candidate = await ruleFor(workflowId, '', node);
  if (!canAllowAlways(candidate.kind, candidate.scope)) return null;
  const rule = await permissionRulesStore.find('workflow', candidate.scope).catch(() => null);
  if (!rule) return null;
  await permissionRulesStore.used(rule.id).catch(() => undefined);
  return rule.label;
}
