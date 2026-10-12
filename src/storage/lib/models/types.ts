/** What a caller needs a model for; the registry picks the best available model for it. */
export type ModelRole =
  | 'fast'
  | 'smart'
  | 'vision'
  | 'local'
  // Pinned once chosen: changing it means embedding the knowledge base again
  | 'embed'
  | 'transcribe'
  | 'realtime'
  | 'tts'
  | 'search';

/** One model a provider offers, as discovered by the registry. */
export interface ModelCatalogEntry {
  // "<providerId>:<model>"
  id: string;
  providerId: string;
  model: string;
  label: string;
  // Runs on this Mac (Ollama, LM Studio): free and private
  local: boolean;
  contextTokens: number | null;
  // US dollars per million tokens, when the provider says
  inputUsdPerM: number | null;
  outputUsdPerM: number | null;
  modalities: string[];
  tools: boolean | null;
  health: 'ok' | 'error' | 'unknown';
  seenAt: number;
}

/** One model call, for usage by model, agent, workflow and workspace. */
export interface UsageEvent {
  id: string;
  at: number;
  // "YYYY-MM-DD" local
  day: string;
  providerId: string;
  model: string;
  role: ModelRole | 'thread';
  sessionId: string;
  agentId: string | null;
  workflowId: string | null;
  runId: string | null;
  workspaceId: string | null;
  inputTokens: number;
  outputTokens: number;
  // null when the price is not known
  costUsd: number | null;
}
