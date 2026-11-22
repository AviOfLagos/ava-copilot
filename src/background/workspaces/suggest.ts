import type { Workspace } from '@extension/storage';
import type { PlaceItem } from './rules';

// What a light model is asked in Part 3 of docs/pm-desk.md, and what code does without it. The model only suggests a
// name and keywords for the sheet (Avi edits them) and guesses where things might go (only ever offered, never moved);
// every answer is checked here before anyone sees it.

export interface Suggestion {
  name: string;
  keywords: string[];
}

export interface GuessLine {
  n: number;
  text: string;
}

export interface GuessWorkspace {
  id: string;
  name: string;
  about: string;
  keywords: string[];
}

export interface SuggestModel {
  /** A name and keywords for a workspace the given things would live in; null when it cannot say. */
  suggest(titles: string[], taken: string[]): Promise<Suggestion | null>;
  /** For each numbered thing, the id of the workspace it may belong to, or null. */
  guess(lines: GuessLine[], workspaces: GuessWorkspace[]): Promise<{ n: number; workspace: string | null }[]>;
}

const STOP = new Set(
  (
    'the and for with from that this they them their there then than are was were has have had not but you your our ' +
    'task tasks meeting meetings call notes note chat chats about into over under what when where which while will ' +
    'would should could can send make follow review update check email plan prepare share new draft'
  ).split(' '),
);

const words = (text: string) => text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [];

/** The words that come up most across the titles, most common first: only words that come up in more than one thing. */
export function commonWords(titles: string[], limit = 4): string[] {
  const counts = new Map<string, number>();
  for (const title of titles) {
    for (const word of new Set(words(title))) {
      if (!STOP.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

const titleCase = (text: string) => text.replace(/\b[a-z]/g, letter => letter.toUpperCase());

/** A name and keywords from the words the things share. Empty when they share none: Avi types one. */
export function fallbackSuggestion(titles: string[]): Suggestion {
  const common = commonWords(titles);
  return { name: common[0] ? titleCase(common[0]) : '', keywords: common.slice(0, 4) };
}

const clean = (keywords: string[]) =>
  [...new Set(keywords.map(word => word.trim().toLowerCase()).filter(word => word.length >= 3 && word.length <= 30))]
    .filter(word => !STOP.has(word))
    .slice(0, 8);

/** A model's suggestion made safe: a short plain name that is not a workspace already, and a few keywords. */
export function checkSuggestion(answer: Suggestion | null, taken: string[]): Suggestion | null {
  if (!answer) return null;
  const name = answer.name
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 60);
  if (name.length < 2) return null;
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (taken.some(other => key(other) === key(name))) return null;
  return { name, keywords: clean(answer.keywords) };
}

// The sheet is usable while the model thinks; past this the words the things share stand in
export const SUGGEST_WITHIN_MS = 8000;

const within = <T>(work: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([work, new Promise<null>(resolve => setTimeout(() => resolve(null), ms))]);

/** What the sheet starts with: the model's suggestion when it gave a good one in time, else the words the things share. */
export async function suggestFor(
  items: PlaceItem[],
  existing: Workspace[],
  model: SuggestModel | null,
  timeoutMs = SUGGEST_WITHIN_MS,
) {
  const titles = items.map(item => item.title).filter(Boolean);
  const taken = existing.map(workspace => workspace.name);
  const asked = model
    ? checkSuggestion(
        await within(
          model.suggest(titles.slice(0, 40), taken).catch(() => null),
          timeoutMs,
        ),
        taken,
      )
    : null;
  return asked ?? fallbackSuggestion(titles);
}

/**
 * A model's guesses made safe: only a workspace that exists, only for a thing that was asked about. A guess is never a
 * reason to move anything; the caller offers it.
 */
export function checkGuesses(
  answers: { n: number; workspace: string | null }[],
  asked: number[],
  workspaces: Workspace[],
): Map<number, string> {
  const ok = new Map<number, string>();
  for (const answer of answers) {
    if (!asked.includes(answer.n) || !answer.workspace) continue;
    if (workspaces.some(workspace => workspace.id === answer.workspace)) ok.set(answer.n, answer.workspace);
  }
  return ok;
}
