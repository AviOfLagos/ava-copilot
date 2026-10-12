/**
 * Fills the {{…}} places in a step's fields with what earlier steps produced. There are no expressions
 * and no code: a place names a value by its path, e.g. {{steps.news.output}} or
 * {{steps.news.output.hits.0.title}}, and anything it cannot find becomes empty.
 * Pure TypeScript, shared with the panel and, later, the Mac companion.
 */

// A place: a dotted path of plain names and numbers between double braces. Global regular expressions keep
// state between uses, so every use makes its own
const PLACE_SOURCE = String.raw`\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}`;
const places = () => new RegExp(PLACE_SOURCE, 'g');
const ONE_PLACE = new RegExp(`^${PLACE_SOURCE}$`);
// Anything between double braces, to catch places written wrong
const anyBraces = () => /\{\{([^{}]*)\}\}/g;

// Characters one place may fill, so one large output cannot swamp a step
export const MAX_PLACE_CHARS = 40_000;

/** The paths of every place in a text, e.g. [['steps', 'news', 'output']]. */
export function templateRefs(text: string): string[][] {
  return [...text.matchAll(places())].map(match => match[1].split('.'));
}

/** Places written wrong, e.g. "{{ steps.news output }}", which would otherwise stay in the text as typed. */
export function malformedPlaces(text: string): string[] {
  return [...text.matchAll(anyBraces())].map(match => match[0]).filter(place => !ONE_PLACE.test(place));
}

/** Reads a value by its path, through own properties and array positions only. */
export function lookupPath(root: unknown, path: string[]): unknown {
  let value: unknown = root;
  for (const key of path) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      if (!/^\d+$/.test(key)) return undefined;
      value = value[Number(key)];
      continue;
    }
    if (typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[…cut at ${max} characters]` : text;
}

/** A value as text for a place: text as it is, data as compact JSON. */
export function stringifyValue(value: unknown, max = MAX_PLACE_CHARS): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return truncate(value, max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return '';
  }
}

/** Fills every place in a text from the scope: { steps: { <id>: { output } }, run: {…}, workflow: {…} }. */
export function resolveTemplate(text: string, scope: Record<string, unknown>, max = MAX_PLACE_CHARS): string {
  return text.replace(places(), (_whole, path: string) => stringifyValue(lookupPath(scope, path.split('.')), max));
}

export interface CompactLimits {
  maxString: number;
  maxArray: number;
  maxDepth: number;
}

const DEFAULT_LIMITS: CompactLimits = { maxString: 600, maxArray: 40, maxDepth: 8 };

/**
 * Makes fetched JSON small enough to pass on: long text is cut, long lists keep their first items, deep
 * nesting is summarised, and keys starting with "_" (an API's internal fields) are dropped.
 */
export function compactJson(value: unknown, limits: CompactLimits = DEFAULT_LIMITS, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > limits.maxString ? `${value.slice(0, limits.maxString)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= limits.maxDepth) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const kept: unknown[] = value.slice(0, limits.maxArray).map(item => compactJson(item, limits, depth + 1));
    if (value.length > limits.maxArray) kept.push(`…and ${value.length - limits.maxArray} more`);
    return kept;
  }
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    result[key] = compactJson(inner, limits, depth + 1);
  }
  return result;
}

/** A value small enough to store with a run step: kept whole when it fits, else cut down to text. */
export function forStorage(value: unknown, max = 200_000): unknown {
  if (value === undefined) return null;
  if (typeof value === 'string') return truncate(value, max);
  try {
    const text = JSON.stringify(value);
    return text === undefined || text.length <= max ? value : truncate(text, max);
  } catch {
    return null;
  }
}
