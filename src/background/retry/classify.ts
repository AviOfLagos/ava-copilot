import type { FailureClass, ThreadErrorKind } from '@extension/storage';

/**
 * The class of every run that ends with an error (docs/growth-team.md, Part 2). Pure: the thread manager asks
 * it when a run ends, and what happens next (a queued retry, or one Inbox item) follows from the class alone.
 */

// What the executor knows about why it failed, beyond the words of the error
export type FailureCode =
  // The model's key is missing or refused
  | 'auth'
  // The model's provider refuses this account
  | 'forbidden'
  // The model would not take the request as it was sent
  | 'bad_request'
  // The firewall in Settings does not allow the page
  | 'url_not_allowed'
  // Another extension holds the tab's debugger
  | 'extension_conflict'
  // The task used every step it may take
  | 'max_steps'
  // Steps failed several times in a row: a page that did not load, a network that dropped, a model overloaded
  | 'max_failures'
  // The user dismissed Chrome's debugging bar
  | 'debugger_closed'
  // The model the settings name does not exist for this key
  | 'model_missing'
  // The model's account is out of credit or over its quota
  | 'billing'
  | 'unknown';

// Tried again after 1, 5, then 15 minutes: three tries
export const RETRY_DELAYS_MS = [1, 5, 15].map(minutes => minutes * 60_000);
export const MAX_AUTO_TRIES = RETRY_DELAYS_MS.length;

const NEEDS_USER: ReadonlySet<FailureCode> = new Set([
  'auth',
  'forbidden',
  'extension_conflict',
  'debugger_closed',
  'model_missing',
  'billing',
]);
const CANNOT: ReadonlySet<FailureCode> = new Set(['bad_request', 'url_not_allowed', 'max_steps']);

/**
 * @param kind - How the thread stopped: its tab closed, the background restarted, or the task failed
 * @param code - For a failed task, what the executor knows about why
 */
export function classify(kind: ThreadErrorKind, code: FailureCode | null | undefined): FailureClass {
  // A closed tab and a restarted background say nothing against the task itself
  if (kind === 'tab_closed' || kind === 'interrupted') return 'temporary';
  if (code && NEEDS_USER.has(code)) return 'needs_user';
  if (code && CANNOT.has(code)) return 'cannot';
  // Steps that kept failing, and anything not understood: trying again is safe (nothing is sent twice, see
  // ../once) and is given up after three tries
  return 'temporary';
}

/** When the next automatic try is due, or null when the tries are used up. */
export function nextRetryAt(triesSoFar: number, now: number): number | null {
  const delay = RETRY_DELAYS_MS[triesSoFar];
  return delay === undefined ? null : now + delay;
}

/**
 * What the words of a step's error say about why steps kept failing. Steps that fail three times in a row end a
 * task as "too many failures", whatever was behind them; a missing model or an empty account will not pass by
 * waiting, so they are told apart from a dropped network here.
 */
export function codeOfStepError(message: string | null | undefined): FailureCode {
  const text = message ?? '';
  if (
    /\b402\b|payment required|insufficient[_ ](credit|fund|balance|quota)|billing|exceeded your current quota|out of credit/i.test(
      text,
    )
  ) {
    return 'billing';
  }
  if (/\b404\b|model[^.]{0,40}(not found|does not exist|not exist)|no such model|unknown model/i.test(text)) {
    return 'model_missing';
  }
  return 'max_failures';
}
