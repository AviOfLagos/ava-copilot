/**
 * Ava Keys output masking. Pure functions, used by the masker (./mask.ts), the one process that holds the
 * values. Nothing here logs or returns a value: results carry names and counts only.
 */

import { realpathSync } from 'node:fs';

/** The masker's report line marker; a line without it did not come from the masker. */
export const MASK_MARKER = 'ava-keys-mask/1';

export interface MaskReport {
  marker: typeof MASK_MARKER;
  started?: true;
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  masked: Record<string, number>;
  unmasked: string[];
  truncated: boolean;
  timedOut: boolean;
  error?: string;
}

/**
 * offboard's childEnv sets HOME, USER, LOGNAME, SHELL and PATH itself (a vault secret can't override them) and
 * macOS adds __CF_USER_TEXT_ENCODING. Every other variable may be a vault secret, including the names offboard
 * passes through from Ava Brain (LANG, TERM, PWD, NO_COLOR...): those count as secrets unless they hold exactly
 * what Ava Brain sent (run.ts vaultEnv).
 */
const FIXED = /^(HOME|USER|LOGNAME|SHELL|PATH|__CF_USER_TEXT_ENCODING)$/;
export const SENT_BY_BRAIN: Record<string, string> = { LANG: 'en_US.UTF-8', NO_COLOR: '1', TERM: 'dumb' };

/** Shorter values are not masked: they would shred ordinary output. Their names are reported instead. */
export const MIN_MASK_LENGTH = 4;

export interface SecretEntry {
  name: string;
  value: string;
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** The secrets in an environment: everything offboard-vault passed except its fixed non-secret variables. */
export function secretEntries(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): SecretEntry[] {
  const out: SecretEntry[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value === '' || FIXED.test(name)) continue;
    if (SENT_BY_BRAIN[name] === value || (name === 'PWD' && samePath(value, cwd))) continue;
    out.push({ name, value });
  }
  return out;
}

/**
 * The base64 characters that depend only on the value when it sits at byte offset 0, 1 or 2 of a longer encoded
 * stream (e.g. `Basic base64(user:PASS)`): the characters shared with the bytes around it are dropped.
 */
export function base64Cores(bytes: Buffer): string[] {
  const out: string[] = [];
  for (const k of [0, 1, 2]) {
    const n = k + bytes.length;
    const b64 = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64');
    const core = b64.slice(Math.ceil((8 * k) / 6), Math.floor((8 * n) / 6));
    // Too short a core would mask ordinary text by chance
    if (core.length >= 6) out.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return out;
}

/** The forms a value commonly takes in output: raw, trimmed, base64 (alone or inside a longer encoding), URL-, JSON- and hex-encoded. */
export function variants(value: string): string[] {
  const forms = new Set<string>();
  // A value imported with a trailing newline or CR is usually printed without it
  for (const v of new Set([value, value.trim()])) {
    if (!v) continue;
    const bytes = Buffer.from(v, 'utf8');
    const b64 = bytes.toString('base64');
    forms.add(v);
    forms.add(b64);
    forms.add(b64.replace(/=+$/, ''));
    forms.add(bytes.toString('base64url'));
    for (const core of base64Cores(bytes)) forms.add(core);
    forms.add(encodeURIComponent(v));
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(bytes.toString('hex'));
    forms.add(bytes.toString('hex').toUpperCase());
  }
  return [...forms].filter(form => form.length >= MIN_MASK_LENGTH);
}

export interface MaskPlan {
  // Longest first, so a value that contains another is replaced whole
  replacements: { form: string; name: string }[];
  // Names whose values are too short to mask safely
  unmasked: string[];
  // Length of the longest form, in bytes: a partial value at a cut is never longer
  longest: number;
}

export function planMask(entries: SecretEntry[]): MaskPlan {
  const replacements: { form: string; name: string }[] = [];
  const unmasked: string[] = [];
  for (const { name, value } of entries) {
    if (value.length < MIN_MASK_LENGTH) {
      unmasked.push(name);
      continue;
    }
    for (const form of variants(value)) replacements.push({ form, name });
  }
  replacements.sort((a, b) => b.form.length - a.form.length || a.name.localeCompare(b.name));
  const longest = Math.max(0, ...replacements.map(r => Buffer.byteLength(r.form)));
  return { replacements, unmasked: unmasked.sort(), longest };
}

/** Replace every form of every value with «NAME». Counts are per name, summed over forms. */
export function applyMask(text: string, plan: MaskPlan, counts: Record<string, number> = {}): string {
  let out = text;
  for (const { form, name } of plan.replacements) {
    if (!out.includes(form)) continue;
    const parts = out.split(form);
    counts[name] = (counts[name] ?? 0) + parts.length - 1;
    out = parts.join(`«${name}»`);
  }
  return out;
}
