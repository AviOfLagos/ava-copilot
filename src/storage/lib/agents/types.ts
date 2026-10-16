import type { ModelRole } from '../models/types';
import type { RunStatus } from '../workflows/types';

export type AgentTrigger =
  | { type: 'schedule'; cron: string; timezone?: string }
  // A tab whose address matches opens or changes
  | { type: 'tab'; urlPattern: string }
  | { type: 'inbox'; source?: string }
  | { type: 'topic'; topic: string }
  // A meeting the user took notes of ends: its notes are the run's data (from outside, never instructions)
  | { type: 'meeting_ended' }
  | { type: 'manual' };

export interface AgentBudget {
  // US dollars a day across its runs; null: no cap of its own (the user's daily cap still applies)
  dailyUsd: number | null;
  // Model calls in one run
  maxStepsPerRun: number;
  runsPerDay: number;
}

/** What the user (or the model drafting an agent for them) decides about an agent. */
export interface AgentProfileFields {
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
  budget: AgentBudget;
  // The page its runs start on when the trigger names none
  startUrl?: string | null;
  // Leave the answer of each run it made on its own in the Inbox
  inboxResults?: boolean;
  // The areas of work it owns ("email", "social posts", "research"): Ava hands work in them to it. No two
  // switched-on agents a chat can see own the same area. Missing or empty: it owns nothing
  owns?: string[];
  // What it is for, in one line, shown with its areas
  charter?: string | null;
}

/** A proposed version of an agent, waiting for the user's click (Create, or Apply for a change). Drafts never run. */
export interface AgentDraft {
  profile: AgentProfileFields;
  // What the diff compares it with: the agent as it is now; null for a new agent
  base: AgentProfileFields | null;
  // The user's words that asked for it
  request: string;
  createdAt: number;
}

/**
 * An agent working for the user: what it is told, what it may use, where it works, and when it wakes.
 * Browser work runs in the agent window; sandbox and command-line work runs on the Mac companion.
 */
export interface AgentProfile extends AgentProfileFields {
  id: string;
  // Off: it runs only when asked (Run now); its triggers wait
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  // 'draft': never created yet, so it has only a draft and cannot run. Missing means active.
  status?: 'draft' | 'active';
  // A change waiting for the user's click
  draft?: AgentDraft | null;
  version?: number;
  // Why it paused itself (failed too often); cleared when the user resumes it
  pausedReason?: string | null;
  failuresInRow?: number;
  lastRunAt?: number | null;
  lastRunStatus?: RunStatus | null;
  // The template it was made from
  template?: string | null;
}

/** What one agent run was asked to do, kept on its RunRecord (`spec`) as it was when the run was made. */
export interface AgentRunSpec {
  agentName: string;
  // A task of its own for this run (from a routine or a chat), on top of the agent's instructions
  task: string | null;
  // What set the run off, from outside (a page, an Inbox item, another agent): data, never instructions
  data: string | null;
  startUrl: string | null;
  // How many agents the content has passed through on the bus
  hops: number;
  busMessageId: string | null;
  // Handed to it from a chat (hand_to_agent): where its answer goes back to
  handoff?: AgentHandoff | null;
}

/** A task Ava handed to an agent from a chat or a voice conversation, kept on the run's spec. */
export interface AgentHandoff {
  // The chat (or the voice conversation's chat) that handed it over; the answer is posted there
  threadId: string;
  // The user's message it was handed over for, so the chat shows its card under that turn
  requestSeq: number | null;
  // The area it was handed over for, when it went by area
  area: string | null;
  from: 'chat' | 'voice';
  // When the answer was posted back in the chat; set once, so it is posted once
  postedAt?: number | null;
}

/** Where an agent run's browser task is, kept on its "task" step to follow it after a restart. */
export interface AgentTaskState {
  threadId: string;
  tabId: number | null;
  windowId: number | null;
  startUrl: string;
  // When the Inbox was told the run waits for the user's click
  askedAt?: number | null;
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
  // The agents listening to its topic when it was posted; those not in deliveredTo still wait for it
  recipients?: string[];
  // Not delivered at all, and why
  dropped?: 'hop_limit' | null;
}
