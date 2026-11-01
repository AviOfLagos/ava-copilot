import type { ProviderConfig } from '@extension/storage';

const DEFAULT_MODEL = 'gemini-3.8-flash';

/**
 * The Gemini model that writes speech down: the one chosen, else a quick one of any Gemini provider with a key, so
 * a key is all dictation needs. Null without a key.
 */
export function geminiSpeechConfig(
  config: { provider?: string; modelName?: string } | null | undefined,
  providers: Record<string, ProviderConfig>,
): { provider: string; modelName: string } | null {
  const chosen = config?.provider ? providers[config.provider] : undefined;
  if (config?.provider && config.modelName && chosen?.type === 'gemini' && chosen.apiKey) {
    return { provider: config.provider, modelName: config.modelName };
  }
  const found = Object.entries(providers).find(
    ([id, provider]) => (provider.type ?? id) === 'gemini' && provider.apiKey,
  );
  if (!found) return null;
  const quick = found[1].modelNames?.find(name => name.includes('flash') && !/live|tts/.test(name));
  return { provider: found[0], modelName: quick ?? DEFAULT_MODEL };
}
