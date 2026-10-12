import type { ModelRole } from '../models/types';

export type AgentTrigger =
  | { type: 'schedule'; cron: string; timezone?: string }
  // A tab whose address matches opens or changes
  | { type: 'tab'; urlPattern: string }
  | { type: 'inbox'; source?: string }
  | { type: 'topic'; topic: string }
  | { type: 'manual' };

/**
 * An agent working for the user: what it is told, what it may use, where it works, and when it wakes.
 * Browser work runs in the agent window; sandbox and command-line work runs on the Mac companion.
 */
export interface AgentProfile {
  id: string;
  name: string;
  // An emoji or short initials
  avatar: string;
  instructions: string;
  // Skill ids it loads
  skills: string[];
  // Connector ids it may use; tools within them follow each connector's policy
  connectors: string[];
  // Sites it may reach; empty means only what its task names
  domains: string[];
  modelRole: ModelRole;
  workspaceId: string | null;
  executor: 'browser' | 'companion';
  triggers: AgentTrigger[];
  // Topics it listens to and posts to on the bus
  subscribes: string[];
  publishes: string[];
  budget: { dailyUsd: number | null; maxStepsPerRun: number; runsPerDay: number };
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A message one agent leaves for others, by topic. */
export interface BusMessage {
  id: string;
  topic: string;
  fromAgentId: string | null;
  runId: string | null;
  payload: unknown;
  // How many agents it has passed through; past the limit it is dropped
  hops: number;
  // It carries content from outside (a page, a message, a connector)
  tainted: boolean;
  deliveredTo: string[];
  createdAt: number;
}
