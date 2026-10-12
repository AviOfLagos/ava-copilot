/** A proposed version of a workflow, waiting for the user's click (Create, or Apply for a change). Drafts never run. */
export interface WorkflowDraft {
  // WorkflowSpec, validated by the engine
  spec: unknown;
  // What the diagram's diff compares it with: the version that runs now, or the draft it replaced
  baseSpec: unknown | null;
  // The user's words that asked for it
  request: string;
  createdAt: number;
}

/** A routine: a trigger, steps and outputs, drawn as a diagram. The spec's shape is the workflow engine's. */
export interface WorkflowRecord {
  id: string;
  name: string;
  description: string;
  workspaceId: string | null;
  // The agent it runs as, if any
  agentId: string | null;
  // WorkflowSpec, validated by the engine; null until the user first clicks Create
  spec: unknown;
  version: number;
  // 'draft': never created yet, so it has only a draft and cannot run
  status: 'draft' | 'active' | 'paused';
  // Paused after too many failures in a row
  failuresInRow: number;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  // A change waiting for the user's click
  draft?: WorkflowDraft | null;
  // How the last run ended, for the list
  lastRunStatus?: RunStatus | null;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  // A side effect was cut off mid-call; the user decides
  | 'unknown_outcome';

// A step can also be passed over: its branch was not taken
export type RunStepStatus = RunStatus | 'skipped';

/** One run of a workflow or an agent. */
export interface RunRecord {
  id: string;
  kind: 'workflow' | 'agent';
  workflowId: string | null;
  agentId: string | null;
  workspaceId: string | null;
  trigger: { type: string; detail: string };
  status: RunStatus;
  // Started by content from outside: it cannot act without approval
  tainted: boolean;
  startedAt: number;
  endedAt: number | null;
  // While running, it is renewed; a run past its lease after a restart is recovered
  leaseUntil: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error: { kind: string; message: string } | null;
  // Started by the user, who is likely watching (Run now, chat, voice); scheduled and event runs are not
  attended?: boolean;
  // The spec it runs, as it was when the run was made, and its version
  spec?: unknown;
  specVersion?: number;
  // One scheduled firing makes one run, even when its job runs twice
  firingKey?: string | null;
  modelCalls?: number;
}

export interface RunStep {
  id: string;
  runId: string;
  nodeId: string;
  index: number;
  status: RunStepStatus;
  sideEffect: boolean;
  attempts: number;
  startedAt: number | null;
  endedAt: number | null;
  input: unknown;
  output: unknown;
  error: { kind: string; message: string } | null;
  // For a step that needs the user's click: whether it was given
  approval?: 'pending' | 'approved' | 'declined' | null;
  // What a long step saved to pick up after a restart, e.g. the chat a browse step started
  state?: unknown;
  // It brought in content from outside
  tainted?: boolean;
}
