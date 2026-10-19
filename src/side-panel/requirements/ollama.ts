/**
 * Pulling a model into the Ollama server on this computer (`POST /api/pull`), with its streamed progress. The
 * extension already talks to the same server for chats and its model list; nothing here goes anywhere else.
 * Ollama answers a pull with one JSON object per line: `{status}` while it resolves, then
 * `{status, digest, total, completed}` for each layer, and `{status: "success"}` at the end (or `{error}`).
 */

export const OLLAMA_ROOT = 'http://localhost:11434';

export interface PullEvent {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/** The server's root from a provider's base URL (`http://localhost:11434/v1` → `http://localhost:11434`). */
export function ollamaRoot(baseUrl?: string | null): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return OLLAMA_ROOT;
  return trimmed.replace(/\/v1$/, '').replace(/\/api$/, '');
}

/** One line of the pull's answer, or null when it is not one. */
export function parsePullLine(line: string): PullEvent | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<PullEvent>;
    if (typeof value !== 'object' || value === null) return null;
    if (typeof value.error === 'string') return { status: 'error', error: value.error };
    if (typeof value.status !== 'string') return null;
    return {
      status: value.status,
      ...(typeof value.digest === 'string' ? { digest: value.digest } : {}),
      ...(typeof value.total === 'number' ? { total: value.total } : {}),
      ...(typeof value.completed === 'number' ? { completed: value.completed } : {}),
    };
  } catch {
    return null;
  }
}

/** Sums each layer's bytes into one progress, as the events come. */
export function createPullProgress() {
  const layers = new Map<string, { total: number; completed: number }>();
  return (event: PullEvent): { received: number; total: number; status: string } => {
    if (event.digest && typeof event.total === 'number') {
      const before = layers.get(event.digest);
      layers.set(event.digest, {
        total: event.total,
        completed: Math.max(before?.completed ?? 0, Math.min(event.completed ?? 0, event.total)),
      });
    }
    let total = 0;
    let received = 0;
    for (const layer of layers.values()) {
      total += layer.total;
      received += layer.completed;
    }
    if (event.status === 'success') received = total;
    return { received, total, status: event.status };
  };
}

/** Whether the server has the model (`qwen3` matches `qwen3:latest`). */
export function hasOllamaModel(names: string[], wanted: string): boolean {
  const full = (name: string) => (name.includes(':') ? name : `${name}:latest`);
  return names.some(name => full(name) === full(wanted));
}

/** The models the server has, or null when it does not answer. */
export async function listOllamaModels(root: string, fetchImpl: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const response = await fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { models?: { name?: string; model?: string }[] };
    return (body.models ?? []).map(model => String(model.name ?? model.model ?? '')).filter(Boolean);
  } catch {
    return null;
  }
}

/** Pulls a model, reporting progress; resolves when the server says success. */
export async function pullOllamaModel(
  root: string,
  model: string,
  onProgress: (progress: { received: number; total: number; status: string }) => void,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${root}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(parsePullLine(text)?.error ?? `Ollama answered ${response.status}.`);
  }
  const progress = createPullProgress();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let succeeded = false;
  const handle = (line: string) => {
    const event = parsePullLine(line);
    if (!event) return;
    if (event.error) throw new Error(event.error);
    if (event.status === 'success') succeeded = true;
    onProgress(progress(event));
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handle(line);
  }
  handle(buffer + decoder.decode());
  if (!succeeded) throw new Error('The download stopped before it finished.');
}
