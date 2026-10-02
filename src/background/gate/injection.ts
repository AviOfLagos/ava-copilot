import { t } from '@extension/i18n';
import { guardrails, ThreatType } from '../services/guardrails';
import type { AgentContext } from '../agent/types';
import { Actors, ExecutionState } from '../agent/event/types';

// Pages already reported, per task, so the user is told once per page
const reported = new WeakMap<AgentContext, Set<string>>();

// Page text that imitates the tags this agent's own prompts use
const SPOOFED_TAG_PATTERN = /\bnano[-_ ]+(untrusted[-_ ]+content|user[-_ ]+request|attached[-_ ]+files)\b/i;

/**
 * Whether page text tries to give the agent instructions: it tells the agent to drop its task or
 * take a new one, or it imitates the agent's own prompt tags. The wider guardrail patterns
 * (e.g. the words "system message") are too common on ordinary pages to report to the user.
 */
export function containsInstructions(pageText: string): boolean {
  return (
    guardrails.detectThreats(pageText, { strict: true }).includes(ThreatType.TASK_OVERRIDE) ||
    SPOOFED_TAG_PATTERN.test(pageText)
  );
}

/**
 * Tells the user when a page tried to instruct the agent. The text is already sanitized and
 * wrapped as untrusted before the model sees it; this only makes the attempt visible.
 *
 * @returns true when a notice was shown
 */
export async function reportPageInstructions(context: AgentContext, url: string, pageText: string): Promise<boolean> {
  const seen = reported.get(context) ?? new Set<string>();
  reported.set(context, seen);
  if (seen.has(url) || !containsInstructions(pageText)) {
    return false;
  }
  seen.add(url);
  await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_NOTICE, t('gate_injection_ignored'));
  return true;
}
