const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';

export type GeminiKeyCheck =
  // The key works; modelIds are the models it can call
  | { status: 'valid'; modelIds: string[] }
  // Google refused the key
  | { status: 'rejected' }
  // The check itself failed (offline, server error), so the key is neither confirmed nor refused
  | { status: 'unknown' };

/**
 * Checks a Gemini API key by listing the models it can call.
 *
 * @param apiKey - The key to check
 * @param fetchFn - Fetch implementation, replaceable in tests
 * @returns Whether the key works, and the model ids it offers when it does
 */
export async function checkGeminiKey(apiKey: string, fetchFn: typeof fetch = fetch): Promise<GeminiKeyCheck> {
  try {
    const response = await fetchFn(GEMINI_MODELS_URL, { headers: { 'x-goog-api-key': apiKey } });
    // Google answers an invalid key with 400 (API_KEY_INVALID), and a missing or blocked key with 401 or 403
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { status: 'rejected' };
    }
    if (!response.ok) {
      return { status: 'unknown' };
    }
    const body = (await response.json()) as { models?: { name?: string }[] };
    const modelIds = (body.models ?? []).map(model => (model.name ?? '').replace(/^models\//, '')).filter(Boolean);
    return { status: 'valid', modelIds };
  } catch {
    return { status: 'unknown' };
  }
}
