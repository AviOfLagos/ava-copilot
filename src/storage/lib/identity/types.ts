/**
 * Who the assistant is and what she knows about the user, kept apart from any personality:
 *
 * - The core identity (Letta's "persona" block): her character, values and purpose. Always in every prompt, on every
 *   surface, below the safety rules. The user edits it in Settings › Personalities › Ava's core; empty fields mean
 *   the default text.
 * - "About you" (Letta's "human" block, with Mem0/Zep-style dated facts): short facts about the user, each with its
 *   source and dates. Only what the user said or confirmed becomes an active fact; anything else waits as
 *   "proposed" until the user confirms it in Settings › About you.
 * - Goals and insights (Generative Agents' plans and reflections): what the user is working towards per workspace,
 *   and a few higher-level observations, refreshed by a daily reflection.
 */

export interface CoreIdentity {
  // Her character: how she comes across. '' keeps the default
  character: string;
  // What she protects and refuses. '' keeps the default
  values: string;
  // What she is for and what she pushes the user towards. '' keeps the default
  purpose: string;
  updatedAt: number | null;
}

export const FACT_CATEGORIES = ['name', 'role', 'company', 'person', 'preference', 'goal', 'other'] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

// Where a fact came from: the user's own words to Ava, their confirmation of a proposed fact, or Settings
export type FactSource = 'said' | 'confirmed' | 'settings';
// Active facts go into prompts; proposed ones wait for the user's confirmation and never do
export type FactStatus = 'active' | 'proposed';

export interface UserFact {
  id: string;
  // One short sentence, e.g. "Runs Nexprove with two co-founders"
  text: string;
  category: FactCategory;
  // The workspace it belongs to, or null for the user in general
  workspaceId: string | null;
  source: FactSource;
  status: FactStatus;
  // Where it was learnt: "voice", "chat", "settings", "reflection"
  via: string;
  createdAt: number;
  updatedAt: number;
  // What it said before, and until when it was true (newest first, at most FACT_HISTORY_MAX)
  previous: { text: string; until: number }[];
}

export type GoalSource = 'user' | 'reflection';

export interface UserGoal {
  id: string;
  text: string;
  workspaceId: string | null;
  source: GoalSource;
  createdAt: number;
  updatedAt: number;
}

export interface Insight {
  id: string;
  text: string;
  workspaceId: string | null;
  createdAt: number;
}

export interface AboutYouState {
  facts: UserFact[];
  goals: UserGoal[];
  insights: Insight[];
  lastReflectionAt: number | null;
}

export const FACT_TEXT_MAX = 280;
export const FACTS_MAX = 150;
export const FACT_HISTORY_MAX = 3;
export const GOAL_TEXT_MAX = 160;
export const GOALS_PER_WORKSPACE_MAX = 3;
export const GOALS_MAX = 24;
export const INSIGHT_TEXT_MAX = 240;
export const INSIGHTS_MAX = 20;
export const CORE_FIELD_MAX = 1200;
