/** One line of the local diagnostic log. Redacted before it is written: no keys, no tokens, no full prompts. */
export interface LogEntry {
  id: string;
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  runId: string | null;
  requestId: string | null;
  data?: Record<string, unknown>;
}
