import type { KnowledgeBase } from './manager';

// The background's one knowledge base, for the agent's search_knowledge action. Kept apart from the
// manager so the agent's actions do not import the thread machinery that imports them.
let shared: KnowledgeBase | null = null;

export function setKnowledgeBase(kb: KnowledgeBase): void {
  shared = kb;
}

export function getKnowledgeBase(): KnowledgeBase | null {
  return shared;
}
