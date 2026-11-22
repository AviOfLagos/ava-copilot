import type { UserFact } from '@extension/storage';
import { visibleTo } from './prompt';

/**
 * Finding a stored fact by what the user asks, for the `recall` action. The prompt shows only the newest 1,500
 * characters of facts; this searches all of them. Plain code, no model: a fact scores by the words it shares with
 * the question (a word and its plural count as one, a few filler words count for nothing).
 */

const FILLER = new Set(
  'a an and are as at be but by do does did for from has have how i if in is it its me my of on or our so that the their them there these they this to was we were what when where which who whom why will with would you your about know tell'.split(
    ' ',
  ),
);

/** The words that carry the meaning, lower case, a plural folded into its singular. */
export function keyWords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [
    ...new Set(
      words.filter(word => !FILLER.has(word) && word.length > 1).map(word => word.replace(/(?<=\w{3})s$/, '')),
    ),
  ];
}

export interface RecalledFact {
  fact: UserFact;
  score: number;
}

/** The active facts a chat in `workspaceId` may see that match the question, best first. */
export function searchFacts(
  facts: UserFact[],
  question: string,
  workspaceId: string | null,
  limit = 8,
): RecalledFact[] {
  const wanted = keyWords(question);
  if (!wanted.length) return [];
  return visibleTo(
    facts.filter(fact => fact.status === 'active'),
    workspaceId,
  )
    .map(fact => {
      const have = new Set(keyWords(`${fact.text} ${fact.category}`));
      return { fact, score: wanted.filter(word => have.has(word)).length };
    })
    .filter(found => found.score > 0)
    .sort((a, b) => b.score - a.score || b.fact.updatedAt - a.fact.updatedAt)
    .slice(0, limit);
}
