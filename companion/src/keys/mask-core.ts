/**
 * Ava Keys output masking. Pure functions, used by the masker (./mask.ts), the one process that holds the
 * values. Nothing here logs or returns a value: results carry names and counts only.
 */

/** The masker's report line marker; a line without it did not come from the masker. */
export const MASK_MARKER = 'ava-keys-mask/1';

export interface MaskReport {
  marker: typeof MASK_MARKER;
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

/** Variables offboard-vault sets for every command (childEnv in offboard lib/vault.mjs): never secrets. */
const NOT_SECRET =
  /^(HOME|USER|LOGNAME|SHELL|PATH|PWD|OLDPWD|SHLVL|_|LANG|LC_[A-Z]+|TERM|COLORTERM|TERM_PROGRAM|TZ|CI|NO_COLOR|FORCE_COLOR|NODE_ENV)$/;

/** Shorter values are not masked: they would shred ordinary output. Their names are reported instead. */
export const MIN_MASK_LENGTH = 4;

export interface SecretEntry {
  name: string;
  value: string;
}

/** The secrets in an environment: everything offboard-vault passed except its fixed non-secret variables. */
export function secretEntries(env: NodeJS.ProcessEnv): SecretEntry[] {
  const out: SecretEntry[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value === '' || NOT_SECRET.test(name)) continue;
    out.push({ name, value });
  }
  return out;
}

/** The forms a value commonly takes in output: raw, base64 (both alphabets, padded or not), URL-, JSON- and hex-encoded. */
export function variants(value: string): string[] {
  const forms = new Set<string>([value]);
  const bytes = Buffer.from(value, 'utf8');
  const b64 = bytes.toString('base64');
  const b64url = bytes.toString('base64url');
  forms.add(b64);
  forms.add(b64.replace(/=+$/, ''));
  forms.add(b64url);
  forms.add(encodeURIComponent(value));
  forms.add(JSON.stringify(value).slice(1, -1));
  forms.add(bytes.toString('hex'));
  forms.add(bytes.toString('hex').toUpperCase());
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
