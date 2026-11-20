import { t } from '@extension/i18n';
import { onceStore, threadStore } from '@extension/storage';
import type { ConfirmRequest, OnceRecord, OnceStep } from '@extension/storage';
import { Actors, ExecutionState } from '../agent/event/types';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import { createLogger } from '../log';

const logger = createLogger('DoOnce');

/**
 * Do-once keys (docs/growth-team.md, Part 2): nothing is sent, posted, submitted, granted or created twice.
 *
 * Every such step writes a record before it acts ("started") and again when its result is in ("done"). The check
 * is code, not the model's memory, so it holds when a task is retried, resumed after the background died, or
 * simply asked for the same thing again:
 *
 * - a step that is done is not run again: the model is told it happened and carries on;
 * - a step left at "started" was cut off before its result was recorded. It may have gone through, so it is not
 *   run again either: the model is told to look for evidence first;
 * - if the model then tries once more, the user is asked on the confirm card, which says why. Only that click
 *   runs it again.
 *
 * Callers: `gate/review.ts` for anything committed on a page, `integrations/action.ts` for a connector's tool.
 */

// Records older than this guard tasks that are long over
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

type Context = Pick<AgentContext, 'taskId' | 'emitEvent'>;

/** What a caller knows about a step before it runs. `parts` say what it acts on; only their hash is kept. */
export interface OnceInput {
  // 'commit' for a page, 'tool' for a connector's tool, or a name of its own ('whatsapp.send')
  what: string;
  // The site or tool, in the open: a cut-off step blocks the next one in the same scope
  scope: string;
  // A few words for the user and the model. Never content, and never text taken from a page.
  label: string;
  parts: string[];
}

export type OnceCheck =
  // Nothing like it exists: go on to the usual approval, then beginOnce
  | { state: 'clear' }
  // It exists and the model has not been told in this run: return this to the model and do not act
  | { state: 'told'; result: ActionResult }
  // The model was told and tries again: only the user's click runs it. Put `repeat` on the confirm request.
  | { state: 'ask'; repeat: NonNullable<ConfirmRequest['repeat']> };

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A short hash of what a step acts on, so no content is kept in the record. */
export async function digest(parts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.map(normalize).join('\u0000'));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** JSON with its keys in order, so the same arguments always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The step a caller is about to run, keyed to the chat's current task: the same task when it is resumed or
 * retried, a new one for every new request (see ThreadManager.send).
 */
export async function stepFor(context: Pick<AgentContext, 'taskId'>, input: OnceInput): Promise<OnceStep> {
  const thread = await threadStore.get(context.taskId).catch(() => undefined);
  return {
    taskId: thread?.taskRunId || context.taskId,
    threadId: context.taskId,
    what: input.what,
    scope: input.scope,
    label: input.label,
    target: await digest([input.scope, ...input.parts]),
  };
}

const timeOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function toldMessage(record: OnceRecord): string {
  const when = timeOf(record.startedAt);
  if (record.status === 'done') {
    return `Already done in this task: ${record.label}, at ${when}${record.result ? ` (${record.result})` : ''}. It was NOT run again, so nothing went out twice. Carry on with the next step. Only if this really is a different step (another recipient, another item), run the action again: the user will be asked first.`;
  }
  return `An earlier step of this task, ${record.label} at ${when}, was cut off before its result was recorded, so it may already have gone through. Nothing was done now. First look for evidence: the sent items, the thread, the page it would have changed. If it went through, skip this step and carry on. If you are sure it did not, run the action again: the user will be asked first.`;
}

function refused(context: Context, record: OnceRecord): ActionResult {
  void context.emitEvent(
    Actors.NAVIGATOR,
    ExecutionState.ACT_FAIL,
    t(record.status === 'done' ? 'gate_once_done' : 'gate_once_cutOff', [record.label]),
  );
  return new ActionResult({ error: toldMessage(record), includeInMemory: true });
}

/**
 * Looks for a record that stands in the way of a step, before anything is shown to the user or done.
 */
export async function checkOnce(context: Context, step: OnceStep): Promise<OnceCheck> {
  const record = await onceStore.blocking(step);
  if (!record) return { state: 'clear' };
  const thread = await threadStore.get(context.taskId).catch(() => undefined);
  // Told since this run started, and it tries again: the model cannot settle it, the user can
  if (record.toldAt !== null && record.toldAt >= (thread?.runStartedAt ?? 0)) {
    return {
      state: 'ask',
      repeat: { status: record.status === 'done' ? 'done' : 'started', at: record.startedAt, label: record.label },
    };
  }
  await onceStore.told(record.key);
  logger.info(`Not repeated (${record.status}): ${record.label}`);
  return { state: 'told', result: refused(context, record) };
}

/**
 * Writes "started" right before the act. The caller must then call `onceStore.finish` (it went through) or
 * `onceStore.fail` (it certainly did not); a step it cannot tell about stays at "started".
 *
 * @param again - The user was shown that the step exists (`repeat` on the card) and approved it
 * @returns The record to settle, or what to tell the model when another writer started the step first
 */
export async function beginOnce(
  context: Context,
  step: OnceStep,
  again: boolean,
): Promise<{ record: OnceRecord } | { result: ActionResult }> {
  const claim = await onceStore.begin(step, { again });
  if (claim.fresh) return { record: claim.record };
  await onceStore.told(claim.record.key);
  return { result: refused(context, claim.record) };
}

/**
 * The key a tool gets when it takes one, so the far side can refuse a repeat too. It stays the same when a
 * cut-off step is run again (the tool can tell it already has it) and changes when the user re-runs a done one.
 */
export async function idempotencyKeyOf(record: OnceRecord): Promise<string> {
  return `ava-${await digest([record.key, String(record.redone)])}`;
}

/**
 * What a resumed or retried run is told about its own task: what already went out, and what was cut off.
 * Empty when the task has done nothing yet.
 */
export async function onceNote(taskId: string | null | undefined): Promise<string> {
  if (!taskId) return '';
  const records = await onceStore.forTask(taskId).catch(() => []);
  const done = records.filter(record => record.status === 'done');
  const cutOff = records.filter(record => record.status === 'started');
  if (done.length + cutOff.length === 0) return '';
  const line = (record: OnceRecord) => `- ${record.label}, at ${timeOf(record.startedAt)}`;
  return [
    done.length ? `Already done in this task, do not do these again:\n${done.map(line).join('\n')}` : '',
    cutOff.length
      ? `Cut off before the result was recorded, so they may have gone through. Check for evidence before anything else, and never repeat one without the user's click:\n${cutOff.map(line).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Drops records of tasks that are long over. Run when the background starts. */
export async function pruneOnce(now = Date.now()): Promise<void> {
  await onceStore.prune(now - KEEP_MS).catch(error => logger.warning('Could not prune do-once records', error));
}
