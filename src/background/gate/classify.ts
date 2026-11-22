import type { CommitKind, NeedsUserKind } from '@extension/storage';

/**
 * The deterministic layer of the confirm gate. It decides from the page, not from the model,
 * whether an action commits something. It is tuned to ask too often: a false positive costs
 * the user one click, a false negative sends something they never approved.
 */

// What the gate knows about the element an action targets
export interface GateTarget {
  tagName: string;
  // The type attribute of a button or input
  inputType: string;
  role: string;
  // Text the user sees or hears for the element: its text, aria-label, title, value and tooltip
  label: string;
  // Words taken from the id, name and test id, for controls that show only an icon
  hints: string;
  href: string;
  editable: boolean;
  inForm: boolean;
  // The element belongs to a search box or search form
  searchLike: boolean;
  // The form around the element has a password field
  formHasPassword: boolean;
  // The element sits in a CAPTCHA widget
  inCaptcha: boolean;
  // The element sits in a spreadsheet or data grid: Enter moves to the next cell and Delete clears one
  inGrid: boolean;
}

export const EMPTY_TARGET: GateTarget = {
  tagName: '',
  inputType: '',
  role: '',
  label: '',
  hints: '',
  href: '',
  editable: false,
  inForm: false,
  searchLike: false,
  formHasPassword: false,
  inCaptcha: false,
  inGrid: false,
};

// The cell itself, as opposed to a control inside it
const GRID_CELL_ROLES = ['gridcell', 'cell', 'row', 'rowheader', 'columnheader'];

// Checked in order, so the more damaging kind wins when a label matches several
const COMMIT_PATTERNS: [CommitKind, RegExp][] = [
  [
    'purchase',
    /\b(buy|purchase|pay|checkout|check out|donate|subscribe|book now|upgrade|(place|complete|confirm)( your| the| my)? (order|purchase|payment|booking)|(send|make|submit|confirm|authori[sz]e) (a |the )?payments?|send money|transfer (funds|money)|refunds?|payouts?|withdraw(al)?)\b/i,
  ],
  [
    'delete',
    /\b(delete|remove|discard|erase|trash|unsubscribe|deactivate|revoke|empty (trash|bin)|cancel( my| the| your)? (subscription|order|plan|membership|account|booking))\b/i,
  ],
  [
    'permission',
    /\b(share|invite|grant|authorize|authorise|make (public|private|admin|owner|editor)|transfer ownership|add (member|members|people|collaborator|collaborators|user|users)|change (role|access|permission|permissions))\b/i,
  ],
  ['publish', /\b(publish|post|tweet|repost|go live|deploy|release|merge)\b/i],
  ['send', /\b(send|comment)\b/i],
  ['submit', /\b(submit|confirm|sign up|register|apply now|enroll|enrol)\b/i],
];

// Labels of submit-type buttons that only move around or look things up
const SAFE_SUBMIT_PATTERN =
  /^\W*(search|find|filter|go|next|back|previous|prev|continue|cancel|close|add|new|edit|show|hide|view|more|open|clear|reset|sort|refresh|preview|upload|attach|browse|choose|select|copy|download|expand|collapse|sign in|log in|login)\b/i;

const OTP_PATTERN =
  /\b(otp|2fa|mfa|totp|one[- ]time|verification code|security code|auth(entication)? code|passcode|6[- ]digit code)\b/i;

const CAPTCHA_PATTERN = /recaptcha|hcaptcha|h-captcha|cf-turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha/i;

/**
 * Finds the commit kind a piece of label text names, if any.
 */
export function classifyLabel(text: string): CommitKind | null {
  for (const [kind, pattern] of COMMIT_PATTERNS) {
    if (pattern.test(text)) {
      return kind;
    }
  }
  return null;
}

/**
 * Whether a string names a CAPTCHA provider or widget.
 */
export function looksLikeCaptcha(text: string): boolean {
  return CAPTCHA_PATTERN.test(text);
}

/**
 * Whether a field asks for a one-time code.
 */
export function looksLikeOneTimeCode(target: Pick<GateTarget, 'label' | 'hints'>, autocomplete = ''): boolean {
  return autocomplete.toLowerCase() === 'one-time-code' || OTP_PATTERN.test(`${target.label} ${target.hints}`);
}

function isSubmitControl(target: GateTarget): boolean {
  const { tagName, inputType } = target;
  if (inputType === 'submit' || inputType === 'image') {
    return tagName === 'button' || tagName === 'input';
  }
  // A button in a form with no type submits the form
  return tagName === 'button' && inputType === '' && target.inForm;
}

/**
 * Decides whether clicking the target commits something.
 *
 * @returns The kind of commit, or null when the click only navigates or edits
 */
export function classifyClick(target: GateTarget): CommitKind | null {
  const isPlainLink = target.tagName === 'a' && /^https?:|^\//i.test(target.href) && target.role !== 'button';
  if (target.inGrid && GRID_CELL_ROLES.includes(target.role)) {
    // Clicking a cell selects it; its text ("Send", "Delete") is data, not a control. A button, link or
    // icon inside the cell is still read as the control it is.
    return null;
  }
  const kind = classifyLabel(target.label) ?? classifyLabel(target.hints);

  if (isPlainLink) {
    // A link navigates. Only the kinds that old-style sites do with a plain link are held back.
    return kind === 'delete' || kind === 'purchase' ? kind : null;
  }
  if (kind) {
    return kind;
  }
  if (isSubmitControl(target) && !target.searchLike && !SAFE_SUBMIT_PATTERN.test(target.label)) {
    return 'submit';
  }
  return null;
}

/**
 * Splits a key string such as "Control+Enter" into its main key and modifiers, lower-cased.
 */
export function parseKeys(keys: string): { key: string; modifiers: string[] } {
  const parts = keys
    .split('+')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
  return { key: parts[parts.length - 1] ?? '', modifiers: parts.slice(0, -1) };
}

/**
 * Decides whether pressing the keys commits something, given the element that has focus.
 * `focus` is null when the focused element could not be read, which is treated as the worst case.
 *
 * @returns The kind of commit, or null when the keys only edit or move
 */
export function classifyKeys(keys: string, focus: GateTarget | null): CommitKind | null {
  const { key, modifiers } = parseKeys(keys);
  const isEnter = key === 'enter' || key === 'return' || key === 'numpadenter';
  const isDelete = key === 'delete' || key === 'backspace';
  const isSpace = key === 'space';

  if (!isEnter && !isDelete && !isSpace) {
    return null;
  }
  if (focus === null) {
    if (isSpace) {
      return null;
    }
    return isEnter ? 'submit' : 'delete';
  }

  const isTextInput =
    focus.tagName === 'input' && !['button', 'submit', 'image', 'checkbox', 'radio', 'file'].includes(focus.inputType);
  const isTextArea = focus.tagName === 'textarea' || focus.editable;
  const isButton = focus.tagName === 'button' || focus.role === 'button' || (focus.tagName === 'input' && !isTextInput);

  if (focus.inGrid && isEnter && (isTextInput || isTextArea) && modifiers.length === 0) {
    // In a spreadsheet's cell editor Enter confirms the cell and moves on: editing, not sending. Delete on a
    // selected row (not a text box) still counts as deleting it.
    return null;
  }

  if (isSpace) {
    // Space on a focused button clicks it; in a text box it is a character
    return isButton ? classifyClick(focus) : null;
  }

  if (isDelete) {
    // Deleting characters in a text box is editing. Anywhere else the key can delete the selected item.
    return isTextInput || isTextArea ? null : 'delete';
  }

  if (isTextArea) {
    // Shift+Enter is a new line. Plain Enter and Ctrl/Cmd+Enter send in chat apps and editors.
    return modifiers.includes('shift') && modifiers.length === 1 ? null : 'send';
  }
  if (isTextInput) {
    return focus.searchLike ? null : (classifyLabel(focus.label) ?? 'submit');
  }
  if (isButton || focus.tagName === 'a') {
    // Enter on a focused control clicks it
    return classifyClick(focus);
  }
  return null;
}

/**
 * Decides whether the page needs the user for this step: a sign-in, a CAPTCHA or a one-time code.
 * The agent never types a password and never works around a CAPTCHA.
 *
 * @param action - The action about to run
 * @param target - The element the action targets
 * @param autocomplete - The autocomplete attribute of the target, if any
 */
export function classifyNeedsUser(
  action: 'click' | 'type',
  target: GateTarget,
  autocomplete = '',
): NeedsUserKind | null {
  if (target.inCaptcha) {
    return 'captcha';
  }
  if (action === 'type') {
    if (target.inputType === 'password' || target.formHasPassword) {
      return 'login';
    }
    if (looksLikeOneTimeCode(target, autocomplete)) {
      return 'code';
    }
    return null;
  }
  // Submitting a form that holds a password is signing in
  if (target.formHasPassword && isSubmitControl(target)) {
    return 'login';
  }
  return null;
}

// Secrets the panel never asks for: a page could word a question to phish them through it
const SECRET_QUESTION =
  /pass\s*(word|code|phrase)|\bpin\b|one[- ]time|\botp\b|\b2fa\b|\bmfa\b|verification code|security code|\bcode\b.*\b(sms|text|email|app)\b|\bcvv\b|\bcvc\b|card number|credit card|debit card|expiry|\bssn\b|social security|national id|\bnin\b|\bbvn\b|secret|token|api key|private key|seed|recovery phrase|mnemonic|security question|mother'?s maiden|login|sign[- ]?in|credentials?/i;

/** Whether a question asks for a secret, which the user only ever types into the site themselves. */
export function asksForSecret(question: string): boolean {
  return SECRET_QUESTION.test(question);
}
