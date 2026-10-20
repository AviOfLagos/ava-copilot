import { t } from '@extension/i18n';
import { gateSettingsStore, threadStore } from '@extension/storage';
import type { CommitKind, ConfirmField, ConfirmRequest, NeedsUserKind } from '@extension/storage';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import { Actors, ExecutionState } from '../agent/event/types';
import type Page from '../browser/page';
import type { DOMElementNode } from '../browser/dom/views';
import { createLogger } from '../log';
import { alwaysAsks } from './origins';
import { classifyClick, classifyKeys, classifyLabel, classifyNeedsUser, EMPTY_TARGET } from './classify';
import type { GateTarget } from './classify';
import { readCommitContent, readCommitEffect, readFocus, readLiveLabel } from './probes';
import type { CommitContent, FocusReading } from './probes';
import { describeTarget, targetFromRaw } from './target';

const logger = createLogger('ConfirmGate');

// How long the page gets to show the result of a committed action before it is checked
const VERIFY_DELAY_MS = 1500;
const MAX_SNIPPETS = 5;
const SNIPPET_LENGTH = 80;

// An action the gate reviews before it runs
export type GatedAction =
  | { action: 'click_element' | 'input_text'; args: Record<string, unknown>; node: DOMElementNode }
  | { action: 'send_keys'; args: Record<string, unknown> };

// A commit that may run, with what is needed to check its effect afterwards
export interface ApprovedCommit {
  kind: CommitKind;
  urlBefore: string;
  // Pieces of the committed text, and how often each showed on the page before the action
  snippets: string[];
  visibleBefore: number[];
}

export type ReviewOutcome =
  // The action may run. `commit` is set when it commits something, so its effect gets verified.
  | { proceed: true; commit: ApprovedCommit | null }
  // The action must not run. `result` is what the agent is told instead.
  | { proceed: false; result: ActionResult };

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

async function readFocusSafely(page: Page): Promise<FocusReading | null> {
  try {
    return await page.evaluateInPage(readFocus, undefined);
  } catch (error) {
    logger.warning('Could not read the focused element', error);
    return null;
  }
}

async function readContent(page: Page, gated: GatedAction): Promise<CommitContent> {
  try {
    if (gated.action === 'send_keys') {
      return await page.evaluateInPage(readCommitContent, null);
    }
    const handle = await page.locateElement(gated.node);
    if (handle) {
      return await handle.evaluate(readCommitContent);
    }
  } catch (error) {
    logger.warning('Could not read back the content to commit', error);
  }
  return { fields: [], context: '' };
}

function sameFields(a: ConfirmField[], b: ConfirmField[]): boolean {
  return a.length === b.length && a.every((field, i) => field.label === b[i].label && field.value === b[i].value);
}

/**
 * Checks that the control the user approved is still the one the action would hit.
 * The user may take a while to answer, and the page can change underneath.
 */
async function isSameControl(page: Page, gated: GatedAction, approved: FocusReading | null): Promise<boolean> {
  try {
    if (gated.action === 'send_keys') {
      const now = await readFocusSafely(page);
      const signature = (focus: FocusReading | null) =>
        focus
          ? `${focus.where}|${focus.element?.tagName}|${focus.element?.attributes.id}|${focus.element?.attributes.name}`
          : '';
      return signature(now) === signature(approved);
    }
    const handle = await page.locateElement(gated.node);
    if (!handle) {
      return false;
    }
    const live = normalize(await handle.evaluate(readLiveLabel)).toLowerCase();
    const expected = normalize(gated.node.getAllTextTillNextClickableElement()).toLowerCase();
    // An icon-only control has no text on either side; nothing to compare
    if (!live || !expected) {
      return true;
    }
    return live.includes(expected.slice(0, 40)) || expected.includes(live.slice(0, 40));
  } catch (error) {
    logger.warning('Could not re-check the control after confirmation', error);
    return false;
  }
}

function snippetsOf(fields: ConfirmField[]): string[] {
  return fields
    .map(field => normalize(field.value))
    .filter(value => value.length >= 4 && !/^•+$/.test(value))
    .map(value => value.slice(0, SNIPPET_LENGTH))
    .slice(0, MAX_SNIPPETS);
}

function blocked(message: string): ReviewOutcome {
  return { proceed: false, result: new ActionResult({ error: message, includeInMemory: true }) };
}

async function ask(context: AgentContext, request: ConfirmRequest) {
  return context.confirmGate.ask(
    request,
    shown => context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(shown)),
    context.controller.signal,
  );
}

async function buildRequest(
  context: AgentContext,
  page: Page,
  mode: ConfirmRequest['mode'],
  kind: ConfirmRequest['kind'],
  intent: string,
  target: string,
  content: CommitContent,
): Promise<ConfirmRequest> {
  let pageTitle = '';
  try {
    pageTitle = await page.title();
  } catch {
    // The title is only shown for orientation
  }
  return {
    id: crypto.randomUUID(),
    taskId: context.taskId,
    mode,
    kind,
    intent,
    target,
    pageTitle,
    pageUrl: page.url(),
    fields: content.fields,
    context: content.context,
  };
}

/** Whether a task runs without the user watching (an agent, a routine, or the user away on WhatsApp): see ./origins. */
async function isUnattended(context: AgentContext): Promise<boolean> {
  return alwaysAsks(await threadStore.get(context.taskId).catch(() => undefined));
}

/**
 * Asks the user every question the agent has about a form, at once, and waits for the answers.
 *
 * @returns One answer per question (blank for one left out), 'skipped' when the user skipped them,
 *   or 'cancelled' when the task was stopped while it waited
 */
export async function askQuestions(
  context: AgentContext,
  page: Page,
  questions: string[],
  intent: string,
): Promise<string[] | 'skipped' | 'cancelled'> {
  if (questions.length === 0) return [];
  const request = await buildRequest(context, page, 'needs_user', 'questions', intent, '', { fields: [], context: '' });
  request.questions = questions;
  const answer = await ask(context, request);
  if (answer === 'cancelled') return 'cancelled';
  if (answer === 'declined') return 'skipped';
  const replies = context.confirmGate.takeReplies(request.id);
  return questions.map((_, index) => (replies[index] ?? '').trim());
}

/**
 * Hands a step to the user: a sign-in, a CAPTCHA or a one-time code. The action never runs.
 * When the user says they are done, the agent is told to read the page again.
 */
async function handToUser(
  context: AgentContext,
  page: Page,
  kind: NeedsUserKind,
  intent: string,
  target: GateTarget,
): Promise<ReviewOutcome> {
  const request = await buildRequest(context, page, 'needs_user', kind, intent, clip(normalize(target.label), 80), {
    fields: [],
    context: '',
  });
  const answer = await ask(context, request);
  if (answer === 'approved') {
    return {
      proceed: false,
      result: new ActionResult({ extractedContent: t('gate_userContinued'), includeInMemory: true }),
    };
  }
  await context.stop();
  return blocked(t('gate_userStopped'));
}

/**
 * Reviews an action right before it runs. Anything that sends, posts, submits, deletes, publishes,
 * buys or changes permissions waits here for the user's click. Two independent signals raise the
 * gate: what the page says about the control (trusted), and what the model declared (a hint).
 *
 * @param context - The agent context of the running task
 * @param page - The page the action runs on
 * @param gated - The action and the element it targets
 */
export async function reviewAction(context: AgentContext, page: Page, gated: GatedAction): Promise<ReviewOutcome> {
  const intent = String(gated.args.intent ?? '');
  const declared = gated.args.commits === true;

  let target = EMPTY_TARGET;
  let focus: FocusReading | null = null;
  let kind: CommitKind | null = null;
  let needsUser: NeedsUserKind | null = null;
  let control: string;

  if (gated.action === 'send_keys') {
    const keys = String(gated.args.keys ?? '');
    focus = await readFocusSafely(page);
    target = targetFromRaw(focus?.element);
    // Focus that cannot be read (an iframe, or a failed read) is treated as the worst case
    kind = classifyKeys(keys, focus === null || focus.where === 'frame' ? null : target);
    if (kind !== null && target.formHasPassword) {
      needsUser = 'login';
    }
    control = normalize(`${keys} ${clip(normalize(target.label), 60)}`);
  } else {
    target = describeTarget(gated.node);
    const autocomplete = String(gated.node.attributes.autocomplete ?? '');
    needsUser = classifyNeedsUser(gated.action === 'input_text' ? 'type' : 'click', target, autocomplete);
    if (gated.action === 'click_element') {
      kind = classifyClick(target);
    }
    control = clip(normalize(target.label) || target.hints, 80);
  }

  if (needsUser !== null) {
    return handToUser(context, page, needsUser, intent, target);
  }
  if (kind === null && declared) {
    kind = classifyLabel(`${intent} ${target.label}`) ?? 'submit';
  }
  if (kind === null) {
    return { proceed: true, commit: null };
  }

  const content = await readContent(page, gated);
  const settings = await gateSettingsStore.getSettings();
  // An agent or a routine works alone: whatever the chat settings say, every commit waits for the click
  const unattended = await isUnattended(context);

  if (settings.confirm[kind] || unattended) {
    const request = await buildRequest(context, page, 'commit', kind, intent, control, content);
    const answer = await ask(context, request);
    if (answer !== 'approved') {
      // A refusal ends the task, so the agent cannot look for another way to do the same thing
      await context.stop();
      return blocked(t('gate_declined'));
    }

    // The answer can take a while. Run the action only if it is still the one that was approved.
    const contentNow = await readContent(page, gated);
    if (!sameFields(content.fields, contentNow.fields) || !(await isSameControl(page, gated, focus))) {
      await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, t('gate_stale'));
      return blocked(t('gate_stale'));
    }
  }

  const snippets = snippetsOf(content.fields);
  let visibleBefore = snippets.map(() => 0);
  try {
    visibleBefore = (await page.evaluateInPage(readCommitEffect, snippets)).visible;
  } catch (error) {
    logger.warning('Could not read the page before the commit', error);
  }
  return { proceed: true, commit: { kind, urlBefore: page.url(), snippets, visibleBefore } };
}

/**
 * Checks the page after a committed action and reports what it shows.
 *
 * @returns The report, or an empty string when the action committed nothing
 */
export async function verifyCommit(context: AgentContext, page: Page, commit: ApprovedCommit | null): Promise<string> {
  if (commit === null) {
    return '';
  }
  await new Promise(resolve => setTimeout(resolve, VERIFY_DELAY_MS));

  let message = t('gate_verify_unknown');
  try {
    const effect = await page.evaluateInPage(readCommitEffect, commit.snippets);
    if (effect.visible.some((count, i) => count > commit.visibleBefore[i])) {
      message = t('gate_verify_shown');
    } else if (effect.url !== commit.urlBefore) {
      message = t('gate_verify_moved', [effect.url]);
    } else if (commit.snippets.length > 0 && !effect.pending.some(Boolean)) {
      message = t('gate_verify_cleared');
    }
  } catch (error) {
    logger.warning('Could not read the page after the commit', error);
  }

  await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_VERIFY, message);
  return message;
}
