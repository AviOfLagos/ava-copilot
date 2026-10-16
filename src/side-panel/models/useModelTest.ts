import { useCallback, useState } from 'react';
import type { ProvidersState } from './useProviders';

export interface ModelTestResult {
  ok: boolean;
  ms: number;
  error: string;
}

// A local model may need to load into memory first
const TEST_TIMEOUT_MS = 75_000;

/** "Test" for one model: the background asks it for a one-word answer (metered like any call). */
export function useModelTest({ request }: Pick<ProvidersState, 'request'>) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, ModelTestResult>>({});

  const run = useCallback(
    async (providerId: string, model: string, key: string) => {
      setBusy(prev => ({ ...prev, [key]: true }));
      try {
        const reply = await request<{ ms?: number }>({ type: 'models_test_model', providerId, model }, TEST_TIMEOUT_MS);
        setResults(prev => ({ ...prev, [key]: { ok: true, ms: reply.ms ?? 0, error: '' } }));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        setResults(prev => ({ ...prev, [key]: { ok: false, ms: 0, error: text } }));
      } finally {
        setBusy(prev => ({ ...prev, [key]: false }));
      }
    },
    [request],
  );

  return { busy, results, run };
}
