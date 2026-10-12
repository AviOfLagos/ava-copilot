/** A routine: a trigger, steps and outputs, drawn as a diagram. The spec's shape is the workflow engine's. */
export interface WorkflowRecord {
  id: string;
  name: string;
  description: string;
  workspaceId: string | null;
  // The agent it runs as, if any
  agentId: string | null;
  // WorkflowSpec, validated by the engine
  spec: unknown;
  version: number;
  status: 'draft' | 'active' | 'paused';
  // Paused after too many failures in a row
  failuresInRow: number;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
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
}

export interface RunStep {
  id: string;
  runId: string;
  nodeId: string;
  index: number;
  status: RunStatus;
  sideEffect: boolean;
  attempts: number;
  startedAt: number | null;
  endedAt: number | null;
  input: unknown;
  output: unknown;
  error: { kind: string; message: string } | null;
}
