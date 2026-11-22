import { t } from '@extension/i18n';
import {
  ALWAYS_ASK_KINDS,
  canAllowAlways,
  gateSettingsStore,
  onceStore,
  pageScope,
  permissionRulesStore,
  threadStore,
} from '@extension/storage';
import type { CommitKind, ConfirmField, ConfirmRequest, NeedsUserKind, RuleCandidate } from '@extension/storage';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import { Actors, ExecutionState } from '../agent/event/types';
import type Page from '../browser/page';
import type { DOMElementNode } from '../browser/dom/views';
import { createLogger } from '../log';
import { beginOnce, checkOnce, stepFor } from '../once';
import type { OnceInput } from '../once';
import { alwaysAsks } from './origins';
import { autoModeAllows } from './autoMode';
import { classifyClick, classifyKeys, classifyLabel, classifyNeedsUser, EMPTY_TARGET } from './classify';
import type { GateTarget } from './classify';
import { readCommitContent, readCommitEffect, readFocus, readLiveLabel } from './probes';
import type { CommitContent, FocusReading } from './probes';
import { ruleMayAnswer } from './taint';
import { describeTarget, targetFromRaw } from './target';

const logger = createLogger('ConfirmGate');

// How long the page gets to show the result of a committed action before it is checked
const VERIFY_DELAY_MS = 1500;
const MAX_SNIPPETS = 5;
const SNIPPET_LENGTH = 80;

// An action the gate reviews before it runs. `once` names the step for its do-once key when the caller knows
// better than the page what it acts on (a chat's name, a file and who it is shared with); `false` for an action
// that only fills a field, which commits nothing yet.
export type GatedAction = (
  | { action: 'click_element' | 'input_text'; args: Record<string, unknown>; node: DOMElementNode }
  | { action: 'send_keys'; args: Record<string, unknown> }
) & {
  once?: OnceInput | false;
  // The rule "Allow every time" would save, when the caller knows the place better than the page's address (a
  // Drive folder). Ignored for money, deleting and access: those are asked every time whatever a caller sends.
  rule?: RuleCandidate;
};

// A commit that may run, with what is needed to check its effect afterwards
export interface ApprovedCommit {
  kind: CommitKind;
  urlBefore: string;
  // Pieces of the committed text, and how often each showed on the page before the action
  snippets: string[];
  visibleBefore: number[];
  // The do-once record written before the action ran ("started"): `verifyCommit` or `settleCommit` closes it
  onceKey: string | null;
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

/**
 * The do-once step of a commit on a page: the site and what is committed. Where the commit is reached from (a
 * button or Enter, this path or that) is left out on purpose, so a retry that gets there another way still finds
 * it. A control with nothing filled in around it (Publish, Merge, Grant) is told apart by its page and label.
 */
function commitStep(page: Page, kind: CommitKind, control: string, content: CommitContent): OnceInput {
  let host = '';
  let path = '';
  try {
    ({ host, pathname: path } = new URL(page.url()));
  } catch {
    // A page with no proper address still gets a key, from what is committed
  }
  const values = content.fields
    .map(field => normalize(field.value))
    .filter(value => value && !/^•+$/.test(value))
    .sort();
  return {
    what: 'commit',
    scope: host,
    label: host ? `${kind} on ${host}` : kind,
    parts: values.length > 0 ? values : [path, control.toLowerCase(), normalize(content.context)],
  };
}

// How a rule names the kind it covers, in the words the confirm card uses
const KIND_TEXT = {
  send: 'gate_kind_send',
  publish: 'gate_kind_publish',
  submit: 'gate_kind_submit',
  delete: 'gate_kind_delete',
  purchase: 'gate_kind_purchase',
  permission: 'gate_kind_permission',
} as const;

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
  // The kind is a worst-case guess, not what the page shows: no "Allow every time" rule may cover it
  let guessed = false;
  let needsUser: NeedsUserKind | null = null;
  // Keys sent where the focus could not be read (an iframe, maybe a payment frame): Auto mode still asks
  let blindKeys = false;
  let control: string;

  if (gated.action === 'send_keys') {
    const keys = String(gated.args.keys ?? '');
    focus = await readFocusSafely(page);
    target = targetFromRaw(focus?.element);
    // Focus that cannot be read (an iframe, or a failed read) is treated as the worst case
    const unreadable = focus === null || focus.where === 'frame';
    kind = classifyKeys(keys, unreadable ? null : target);
    guessed = unreadable;
    blindKeys = unreadable;
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
    guessed = true;
  }
  if (kind === null) {
    // Typing into a field: the task is now in the middle of a form
    if (gated.action === 'input_text') context.markForm?.();
    return { proceed: true, commit: null };
  }

  const content = await readContent(page, gated);

  // Do once: a step this task already did, or one that was cut off, is not run again by itself
  const step =
    gated.once === false ? null : await stepFor(context, gated.once ?? commitStep(page, kind, control, content));
  const once = step ? await checkOnce(context, step) : { state: 'clear' as const };
  if (once.state === 'told') {
    return { proceed: false, result: once.result };
  }
  const asked = once.state === 'ask' ? once : null;
  const repeat = asked?.repeat;

  const settings = await gateSettingsStore.getSettings();
  // An agent or a routine works alone: whatever the chat settings say, every commit waits for the click
  const unattended = await isUnattended(context);

  // "Allow every time": the user already said yes to this kind of step in this place. Looked up only when a
  // card would show. A repeat of a step (do once) is still asked, money, deleting and access never get a rule,
  // and neither does a kind that is only a guess (focus that could not be read, or the model's word). A run that
  // read content from outside (a page, an email, someone else's message) gets no rule either, answering or offered:
  // what it read must not be able to unlock an approval. The card shows as usual.
  const mayKeep = await ruleMayAnswer(context, kind);
  const mayKeepNamed = gated.rule ? await ruleMayAnswer(context, gated.rule.kind) : false;
  const needsCard = settings.confirm[kind] || unattended || !!repeat;
  // Auto mode: the user told this task not to ask. A repeat of a step still asks.
  const auto = needsCard && !repeat && !blindKeys && (await autoModeAllows(context.taskId, kind));
  if (auto) {
    let host = '';
    try {
      host = new URL(page.url()).host;
    } catch {
      // A page with no proper address is named by its control alone
    }
    await context.emitEvent(
      Actors.NAVIGATOR,
      ExecutionState.ACT_START,
      t('gate_autoApproved', [control || t(KIND_TEXT[kind]), host || '-']),
    );
  }
  const named =
    mayKeepNamed && gated.rule && !ALWAYS_ASK_KINDS.includes(kind) && canAllowAlways(gated.rule.kind, gated.rule.scope)
      ? gated.rule
      : null;
  const scope = named ? named.scope : guessed ? '' : pageScope(page.url());
  const ruleKind = named ? named.kind : kind;
  const rule =
    !auto && (named ? mayKeepNamed : mayKeep) && needsCard && !repeat && scope
      ? await permissionRulesStore.find(ruleKind, scope).catch(() => null)
      : null;
  if (rule) {
    await permissionRulesStore.used(rule.id).catch(() => undefined);
    await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, t('gate_allowedByRule', [rule.label]));
  }

  // Running a step again is the user's call, whatever the settings say
  if (!rule && !auto && needsCard) {
    const request = await buildRequest(context, page, 'commit', kind, intent, control, content);
    if (repeat) request.repeat = repeat;
    else if (named) request.always = named;
    else if (mayKeep && scope && canAllowAlways(kind)) {
      request.always = { kind, scope, label: t('gate_rule_label', [t(KIND_TEXT[kind]), scope]) };
    }
    const answer = await ask(context, request);
    if (answer !== 'approved') {
      // A refusal ends the task, so the agent cannot look for another way to do the same thing
      await context.stop();
      return blocked(t('gate_declined'));
    }
    if (request.always && context.confirmGate.takeAlways(request.id)) {
      await permissionRulesStore.allow(request.always).catch(error => logger.warning('Could not save the rule', error));
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
  // "Started" is written last, right before the caller acts: nothing between here and the act can fail quietly
  const claim = step ? await beginOnce(context, step, asked) : null;
  if (claim && 'result' in claim) {
    return { proceed: false, result: claim.result };
  }
  // A submit or a send is about to run: a page lost right after it is not reopened blindly
  context.markForm?.();
  return {
    proceed: true,
    commit: { kind, urlBefore: page.url(), snippets, visibleBefore, onceKey: claim?.record.key ?? null },
  };
}

/**
 * Closes the do-once record of a commit whose caller checks the result itself: it went through.
 * A commit that is never settled stays at "started", which is right when the caller cannot tell.
 */
export async function settleCommit(commit: ApprovedCommit | null, result: string): Promise<void> {
  if (!commit?.onceKey) return;
  await onceStore.finish(commit.onceKey, result).catch(error => logger.warning('Could not record a result', error));
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
  // What the page showed, in words that keep nothing of it: no address, no text
  let outcome: string | null = null;
  try {
    const effect = await page.evaluateInPage(readCommitEffect, commit.snippets);
    if (effect.visible.some((count, i) => count > commit.visibleBefore[i])) {
      message = t('gate_verify_shown');
      outcome = 'the page showed it';
    } else if (effect.url !== commit.urlBefore) {
      message = t('gate_verify_moved', [effect.url]);
      outcome = 'the page moved on';
    } else if (commit.snippets.length > 0 && !effect.pending.some(Boolean)) {
      message = t('gate_verify_cleared');
      outcome = 'the text left the box';
    }
  } catch (error) {
    logger.warning('Could not read the page after the commit', error);
  }

  // The page shows it went through: the step is done. When the page shows nothing new (a short message, a form
  // that keeps its values, a validation error), the step is neither called done, which could drop a send for
  // good, nor left as cut off, which would hold up the next, different send: it holds back only itself.
  if (outcome) await settleCommit(commit, outcome);
  else if (commit.onceKey) {
    await onceStore
      .unsure(commit.onceKey, 'the page showed no sign either way')
      .catch(error => logger.warning('Could not record a result', error));
  }
  await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_VERIFY, message);
  return message;
}
