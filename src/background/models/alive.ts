import { getProviderTypeByProviderId, ProviderTypeEnum } from '@extension/storage';
import type { ProviderConfig } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { ollamaRoot, providerBaseUrl } from './discovery';
import { fetchJson } from './http';

/** Whether a local server (Ollama, LM Studio) answers now, for light work and for the cloud fallback. */

// How long a "the local server answers" check is trusted
const ALIVE_TTL_MS = 60_000;
const ALIVE_TIMEOUT_MS = 1500;
const alive = new Map<string, { ok: boolean; at: number }>();

/** Forgets the local server checks (tests, or after the user starts a server). */
export function forgetLocalChecks(): void {
  alive.clear();
}

/** Whether a local provider's server answers now: a quick list request, remembered for a minute. */
export async function localServerAnswers(
  providerId: string,
  config: ProviderConfig,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  const cached = alive.get(providerId);
  if (cached && Date.now() - cached.at < ALIVE_TTL_MS) return cached.ok;
  const type = config.type ?? getProviderTypeByProviderId(providerId);
  const url =
    type === ProviderTypeEnum.Ollama
      ? `${ollamaRoot(config.baseUrl)}/api/tags`
      : `${providerBaseUrl(type, config.baseUrl) ?? ''}/models`;
  let ok = false;
  try {
    await fetchJson(url, { retry: false, timeoutMs: ALIVE_TIMEOUT_MS, fetch: fetchFn });
    ok = true;
  } catch (error) {
    // A server without a model list still answers chats; one that refuses this extension (403) does not
    const status = toAppError(error).status;
    ok = status === 404 || status === 405;
  }
  alive.set(providerId, { ok, at: Date.now() });
  return ok;
}
