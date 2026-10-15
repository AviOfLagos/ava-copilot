import { isFactCategory } from '@extension/storage';
import type { FactCategory, FactStatus } from '@extension/storage';

/**
 * Which facts about the user may be saved as true. Only the user's own words count: a fact becomes active when what
 * the user said (typed or spoken in this conversation) supports it; anything else, such as something read on a
 * page, in someone else's chat or in an imported session, is only proposed, and waits for the user to confirm it
 * in Settings › About you. Runs nobody is watching (agents, routines, the brief) save nothing.
 */

// Runs started by something other than the user: they never write the user's memory
export const UNATTENDED_ORIGINS = new Set(['agent', 'workflow', 'brief']);

const STOPWORDS = new Set(
  (
    'the and for with from that this they them their there then than are was were has have had his her hers him she ' +
    'you your yours our ours its who whom what when where which while about into onto over under also just very ' +
    'user users really like likes liked being been will would should could can cant dont does did not but any all ' +
    'some more most much many one two now always never usually mine myself himself herself'
  ).split(' '),
);

/** The words of a text that carry meaning: lower case, letters and digits, three or more characters. */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length >= 3 && !STOPWORDS.has(word));
}

// A rough stem: "runs" → "run", "working" → "work", "liked" → "lik"
const stem = (word: string) => word.replace(/(ing|ed|es|s)$/, '') || word;

// "runs" and "run", "works" and "working", "founded" and "founder": the same word for this check
const sameWord = (a: string, b: string) => {
  if (a === b || stem(a) === stem(b)) return true;
  return a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4) && Math.abs(a.length - b.length) <= 3;
};

/**
 * Whether the user's own words support a fact: at least 60% of the fact's meaningful words (and at least one) were
 * said by the user. Rewording ("I run Nexprove" → "Runs Nexprove") passes; a fact with names or details the user
 * never said does not.
 */
export function supportedByUser(fact: string, userWords: string): boolean {
  const wanted = [...new Set(contentWords(fact))];
  if (!wanted.length) return false;
  const said = contentWords(userWords);
  const found = wanted.filter(word => said.some(other => sameWord(word, other)));
  return found.length / wanted.length >= 0.6;
}

/** Whether the user asked to forget or correct something, in their own words. */
export function askedToForget(userWords: string): boolean {
  return /\b(forget|delete|remove|erase|wrong|not true|no longer|not anymore|isn'?t true|outdated|don'?t remember)\b/i.test(
    userWords,
  );
}

/** The status a fact gets: active when the user's words support it, else proposed. */
export function factStatusFor(fact: string, userWords: string): FactStatus {
  return supportedByUser(fact, userWords) ? 'active' : 'proposed';
}

export const categoryOf = (value: unknown): FactCategory => (isFactCategory(value) ? value : 'other');

/** What the tool says back about a saved fact, so the model knows whether it is in use. */
export function savedNote(text: string, status: FactStatus): string {
  return status === 'active'
    ? `Remembered: "${text}". It is in what you know about the user from now on.`
    : `Kept "${text}" as a suggestion only: the user did not say it in their own words here, so it waits for them to confirm it in Settings › About you. Tell them that in a few words.`;
}

/** A user message without what came from elsewhere: attached files and anything wrapped as outside content. */
export function ownWords(content: string): string {
  return content
    .replace(/<nano_attached_files>[\s\S]*?<\/nano_attached_files>/g, ' ')
    .replace(/<nano_file_content[\s\S]*?<\/nano_file_content>/g, ' ')
    .replace(/<nano_untrusted_content>[\s\S]*?<\/nano_untrusted_content>/g, ' ');
}
