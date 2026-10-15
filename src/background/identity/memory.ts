import { aboutYouStore, addFact, findFact, removeFact, updateFact, visibleFactsFor } from '@extension/storage';
import type { FactCategory, FactChange } from '@extension/storage';
import { askedToForget, factStatusFor, savedNote } from './facts';

/**
 * Remembering and correcting facts about the user, shared by the voice tools and the chat agent's actions. The
 * caller passes what the user said in their own words; ./facts.ts decides whether a fact is active or proposed.
 */

export async function rememberFact(input: {
  text: string;
  category: FactCategory;
  workspaceId: string | null;
  // What the user said in this conversation, in their own words
  userWords: string;
  via: string;
}): Promise<string> {
  const status = factStatusFor(input.text, input.userWords);
  const result = await aboutYouStore.change<FactChange>(state => {
    const change = addFact(
      state,
      {
        text: input.text,
        category: input.category,
        workspaceId: input.workspaceId,
        source: 'said',
        status,
        via: input.via,
      },
      Date.now(),
    );
    return change.ok ? { state: change.state, result: change } : { state, result: change };
  });
  if (!result.ok) return result.error;
  return savedNote(result.fact.text, result.fact.status);
}

export async function updateMemory(input: {
  // Which fact: its id or some of its words
  fact: string;
  newText?: string;
  forget?: boolean;
  workspaceId: string | null;
  userWords: string;
  via: string;
}): Promise<string> {
  const state = await aboutYouStore.getState();
  const visible = { ...state, facts: visibleFactsFor(state.facts, input.workspaceId) };
  const found = findFact(visible, input.fact);
  if (!found) return `No fact about the user matches "${input.fact}".`;
  if (input.forget) {
    // Forgetting is the user's call: only on their own words
    if (!askedToForget(input.userWords)) return 'The user did not ask to forget it. Ask them first.';
    await aboutYouStore.change(current => ({ state: removeFact(current, found.id), result: null }));
    return `Forgot: "${found.text}".`;
  }
  const newText = input.newText?.trim();
  if (!newText) return 'Say what the fact should say now, or set forget.';
  const status = factStatusFor(newText, input.userWords);
  const result = await aboutYouStore.change<FactChange>(current => {
    const change = updateFact(current, found.id, { text: newText, status }, Date.now());
    return { state: change.ok ? change.state : current, result: change };
  });
  if (!result.ok) return result.error;
  return status === 'active'
    ? `Updated: it now says "${result.fact.text}" (it said "${found.text}" until now).`
    : savedNote(result.fact.text, status);
}

/** The facts kept about the user, for "what do you know about me?". */
export async function describeMemory(workspaceId: string | null): Promise<string> {
  const state = await aboutYouStore.getState();
  const facts = visibleFactsFor(state.facts, workspaceId);
  if (!facts.length) return 'You know nothing about the user yet.';
  return facts
    .map(fact => `- ${fact.text}${fact.status === 'proposed' ? ' (a suggestion, not confirmed)' : ''} [id ${fact.id}]`)
    .join('\n');
}
