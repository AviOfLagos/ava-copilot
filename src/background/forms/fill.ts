import { z } from 'zod';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { askQuestions, reviewAction } from '../gate/review';
import { asksForSecret } from '../gate/classify';
import type { DOMElementNode } from '../browser/dom/views';

export const fillFormActionSchema = {
  name: 'fill_form',
  description:
    'Fill a whole form in one action: every field you have a value for, from the task, the conversation or the knowledge base. ' +
    'Put everything you do not know in questions instead of guessing: the user is asked all of them at once after the known fields are filled, ' +
    'and their answers come back so one more fill_form fills the rest. Text fields take text, selects take the option text, ' +
    'checkboxes and radio buttons take "true" to be ticked. Never submits: click the submit button afterwards.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    fields: z
      .array(z.object({ index: z.number().int().describe('index of the field'), value: z.string() }))
      .default([])
      .describe('every field to fill now'),
    questions: z
      .array(z.string())
      .max(20)
      .default([])
      .describe('one short question per value you do not know, e.g. "What is your date of birth?"'),
  }),
} satisfies ActionSchema;

type FieldKind = 'text' | 'select' | 'tick';

/** How a field takes its value: typed, chosen from a list, or ticked. */
export function fieldKind(node: Pick<DOMElementNode, 'tagName' | 'attributes'>): FieldKind {
  const tag = (node.tagName ?? '').toLowerCase();
  const type = String(node.attributes.type ?? '').toLowerCase();
  const role = String(node.attributes.role ?? '').toLowerCase();
  if (tag === 'select') return 'select';
  if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio') return 'tick';
  return 'text';
}

/** Whether a value asks for a box to be ticked. */
export function wantsTick(value: string): boolean {
  return /^(true|yes|y|on|checked|tick|1|x)$/i.test(value.trim());
}

/** What the agent is told about the user's answers. */
export function describeAnswers(questions: string[], answers: string[]): string {
  const lines = questions.map((question, index) =>
    answers[index] ? `- ${question} → ${answers[index]}` : `- ${question} → (left blank: leave this field empty)`,
  );
  return `The user answered the form's questions. Fill these with one more fill_form:\n${lines.join('\n')}`;
}

/**
 * Handles fill_form: checks every field at the gate first (a password or a code is the user's to
 * type), then fills them all without stopping between fields, then asks every open question at once.
 * Indices are the ones the agent saw, so fields that appear while filling do not shift them.
 */
export async function fillFormAction(
  context: AgentContext,
  input: z.infer<typeof fillFormActionSchema.schema>,
): Promise<ActionResult> {
  const intent = input.intent || `Fill ${input.fields.length} fields`;
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
  const page = await context.browserContext.getCurrentPage();
  let selectorMap = page.getSelectorMap();
  if (selectorMap.size === 0) selectorMap = (await page.getState()).selectorMap;

  const planned: { index: number; value: string; node: DOMElementNode; kind: FieldKind }[] = [];
  const problems: string[] = [];
  for (const field of input.fields) {
    const node = selectorMap.get(field.index);
    if (!node) {
      problems.push(`[${field.index}] not on the page`);
      continue;
    }
    const kind = fieldKind(node);
    if (kind === 'tick' && !wantsTick(field.value)) continue;
    planned.push({ ...field, node, kind });
  }

  // Every field passes the gate before any is filled, so a hand-over never leaves half a form
  for (const field of planned) {
    const review = await reviewAction(context, page, {
      action: field.kind === 'tick' ? 'click_element' : 'input_text',
      args: { intent, index: field.index, text: field.value },
      node: field.node,
      // Filling a field sends nothing: the button that submits the form is what takes a do-once key
      once: false,
    });
    if (!review.proceed) return review.result;
  }

  const filled: string[] = [];
  for (const field of planned) {
    try {
      if (field.kind === 'select') {
        await page.selectDropdownOption(field.index, field.value);
      } else if (field.kind === 'tick') {
        const handle = await page.locateElement(field.node);
        const ticked = await handle?.evaluate(element =>
          element instanceof HTMLInputElement ? element.checked : element.getAttribute('aria-checked') === 'true',
        );
        if (!ticked) await page.clickElementNode(context.options.useVision, field.node);
      } else {
        await page.inputTextElementNode(context.options.useVision, field.node, field.value);
      }
      filled.push(`[${field.index}]`);
    } catch (error) {
      problems.push(`[${field.index}] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let report = `Filled ${filled.length} of ${input.fields.length} fields in one go${filled.length ? `: ${filled.join(' ')}` : ''}.`;
  if (problems.length) report += ` Not filled: ${problems.join('; ')}.`;
  context.emitEvent(Actors.NAVIGATOR, problems.length ? ExecutionState.ACT_FAIL : ExecutionState.ACT_OK, report);

  const asked = input.questions.map(question => question.trim().slice(0, 200)).filter(Boolean);
  // Never through the panel: passwords, codes, card numbers and the like are typed by the user on the site
  const secret = asked.filter(asksForSecret);
  const questions = asked.filter(question => !asksForSecret(question));
  if (secret.length) {
    report += ` Not asked, because the user types these on the site themselves: ${secret.map(q => `"${q}"`).join(', ')}. Leave those fields for them and say so in done.`;
  }
  if (questions.length) {
    const answers = await askQuestions(context, page, questions, intent);
    if (answers === 'cancelled') return new ActionResult({ error: 'The task was stopped.', includeInMemory: true });
    report +=
      answers === 'skipped'
        ? ' The user skipped the questions: leave those fields empty and say which in done.'
        : `\n${describeAnswers(questions, answers)}`;
  }
  return new ActionResult({ extractedContent: report, includeInMemory: true });
}
