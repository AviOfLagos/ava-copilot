import { columnKey } from './csv';
import type { CsvTable } from './csv';
import { BULK_MAX_MESSAGE_CHARS, BULK_MAX_RECIPIENTS } from './types';
import type { BulkDailyCount, BulkRecipient, BulkSettings } from './types';

/**
 * The pure parts of a bulk send: rendering the template for each row, reading phone numbers, dedupe and
 * opt-out, and when each message may go. The background runs a batch with these; the panel previews with
 * the same functions, so what the user approves is what is sent.
 */

// ── Template ──────────────────────────────────────────────────────────────────────────────────────

export interface RenderedTemplate {
  text: string;
  // Placeholders with no value in this row
  missing: string[];
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** The placeholders a template uses, as column keys. */
export function templateKeys(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map(match => columnKey(match[1])))];
}

/** Fills `{{name}}` / `{{any column}}` from a row; an unknown or empty one renders as nothing. */
export function renderTemplate(template: string, fields: Record<string, string>): RenderedTemplate {
  const missing = new Set<string>();
  const text = template.replace(PLACEHOLDER, (_whole, raw: string) => {
    const key = columnKey(raw);
    const value = fields[key];
    if (value === undefined || value === '') {
      missing.add(key);
      return '';
    }
    return value;
  });
  // A missing value can leave doubled spaces ("Hi  ,"): tidy them, keep line breaks
  const tidy = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?])/g, '$1')
    .trim();
  return { text: tidy, missing: [...missing] };
}

// ── Phone numbers ─────────────────────────────────────────────────────────────────────────────────

/**
 * A phone number as WhatsApp's send link wants it: digits only, with the country code. Accepts "+", "00",
 * spaces, dashes, dots and brackets. Null when it cannot be a full international number (8 to 15 digits).
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[a-z]/i.test(trimmed.replace(/^tel:/i, ''))) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (!trimmed.startsWith('+') && digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
  return digits;
}

const PHONE_COLUMNS = ['phone', 'phone_number', 'number', 'mobile', 'whatsapp', 'tel', 'telephone', 'cell', 'msisdn'];
const NAME_COLUMNS = ['name', 'full_name', 'first_name', 'contact', 'contact_name'];
const OPT_OUT_COLUMNS = ['opt_out', 'optout', 'opted_out', 'unsubscribe', 'unsubscribed', 'do_not_contact', 'stop'];
const OPT_OUT_VALUES = ['yes', 'y', 'true', '1', 'x', 'stop', 'opted out', 'opted_out', 'unsubscribed', 'opt out'];

function findColumn(headers: string[], candidates: string[]): string | null {
  return candidates.find(candidate => headers.includes(candidate)) ?? null;
}

export interface BulkColumns {
  phone: string | null;
  name: string | null;
  optOut: string | null;
}

export function detectColumns(headers: string[]): BulkColumns {
  return {
    phone: findColumn(headers, PHONE_COLUMNS),
    name: findColumn(headers, NAME_COLUMNS),
    optOut: findColumn(headers, OPT_OUT_COLUMNS),
  };
}

export function isOptedOut(value: string | undefined): boolean {
  return OPT_OUT_VALUES.includes((value ?? '').trim().toLowerCase());
}

export type BulkSkipReason = 'duplicate' | 'opted_out' | 'invalid_number' | 'empty_message' | 'too_long';

export interface PreparedBatch {
  columns: BulkColumns;
  recipients: BulkRecipient[];
  // Rows beyond the most a batch takes, left out
  truncated: number;
  // Placeholders the template uses that no column provides
  unknownPlaceholders: string[];
}

/**
 * Every row of the list as a recipient, in order: the ones that will be sent ("pending") with their message,
 * and the rest skipped with a reason, so the user sees exactly who will not get a message, and why.
 *
 * @throws When the list has no phone column
 */
export function prepareBatch(table: CsvTable, template: string): PreparedBatch {
  const columns = detectColumns(table.headers);
  if (!columns.phone) {
    throw new Error('The list needs a phone column (phone, number, mobile or whatsapp).');
  }
  const phoneColumn = columns.phone;
  const seen = new Set<string>();
  const rows = table.rows.slice(0, BULK_MAX_RECIPIENTS);
  const recipients = rows.map((fields): BulkRecipient => {
    const phone = normalizePhone(fields[phoneColumn] ?? '');
    const name = columns.name ? (fields[columns.name] ?? '') : '';
    const base = { phone: phone ?? (fields[phoneColumn] ?? '').trim(), name, fields, at: null };
    const skip = (reason: BulkSkipReason, message = ''): BulkRecipient => ({
      ...base,
      message,
      status: 'skipped',
      reason,
    });
    if (!phone) return skip('invalid_number');
    if (seen.has(phone)) return skip('duplicate');
    seen.add(phone);
    if (columns.optOut && isOptedOut(fields[columns.optOut])) return skip('opted_out');
    const { text } = renderTemplate(template, fields);
    if (!text) return skip('empty_message');
    if (text.length > BULK_MAX_MESSAGE_CHARS) return skip('too_long', text);
    return { ...base, message: text, status: 'pending', reason: '' };
  });
  const known = new Set(table.headers);
  return {
    columns,
    recipients,
    truncated: Math.max(0, table.rows.length - rows.length),
    unknownPlaceholders: templateKeys(template).filter(key => !known.has(key)),
  };
}

// ── Pacing ────────────────────────────────────────────────────────────────────────────────────────

/** A whole number of seconds between min and max, both included. */
export function randomSeconds(min: number, max: number, random: () => number = Math.random): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return low + Math.floor(random() * (high - low + 1));
}

export interface NextWait {
  ms: number;
  // A cooldown pause rather than the ordinary gap
  cooldown: boolean;
}

/**
 * How long to wait after a message went out. Every `cooldownEvery` messages the wait is a cooldown instead.
 *
 * @param sinceCooldown - Messages sent since the last cooldown, counting the one just sent
 */
export function nextWait(settings: BulkSettings, sinceCooldown: number, random: () => number = Math.random): NextWait {
  if (sinceCooldown >= settings.cooldownEvery) {
    return { ms: randomSeconds(settings.cooldownMinSec, settings.cooldownMaxSec, random) * 1000, cooldown: true };
  }
  return { ms: randomSeconds(settings.delayMinSec, settings.delayMaxSec, random) * 1000, cooldown: false };
}

/** How many more bulk messages may go today. A count from another day does not count. */
export function remainingToday(count: BulkDailyCount, today: string, cap: number): number {
  const sent = count.day === today ? count.sent : 0;
  return Math.max(0, cap - sent);
}

/** The count after one more message today. */
export function countOneMore(count: BulkDailyCount, today: string): BulkDailyCount {
  return { day: today, sent: (count.day === today ? count.sent : 0) + 1 };
}
