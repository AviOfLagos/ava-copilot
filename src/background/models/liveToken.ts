import { getProviderTypeByProviderId, llmProviderStore, ProviderTypeEnum } from '@extension/storage';
import { AppError } from '@extension/shared';
import type { RetryPolicy } from '@extension/shared';
import { fetchJson } from './http';

/**
 * Short-lived Gemini Live tokens, so the API key never rides in a WebSocket address (where it would sit in
 * the offscreen document and in any request log). The background mints one with the key; the offscreen
 * document connects with the token, and asks for a fresh one to reconnect.
 * See https://ai.google.dev/gemini-api/docs/ephemeral-tokens (v1beta for both minting and connecting).
 */

export const AUTH_TOKENS_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
// Tokens only open sessions on the constrained Live endpoint, with access_token in place of key
export const LIVE_CONSTRAINED_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

// The defaults Google documents: a session may run 30 minutes, and must start within a minute
const SESSION_MS = 30 * 60_000;
const START_WITHIN_MS = 60_000;

export interface LiveToken {
  // "auth_tokens/…": passed as access_token
  token: string;
  endpoint: string;
  // Messages are refused after this; a session must start before newSessionUntil
  expiresAt: number;
  newSessionUntil: number;
}

export interface MintOptions {
  // Sessions the token may start; one per connection, so a reconnect asks for a new token
  uses?: number;
  sessionMs?: number;
  startWithinMs?: number;
  // Locks the token to this Live model ("models/…" is added)
  model?: string;
  fetch?: typeof fetch;
  retryPolicy?: Partial<RetryPolicy>;
  now?: () => number;
}

/**
 * Mints a Live token with the Gemini key. Minting has no effect beyond the token, so it is retried like a read.
 *
 * @throws AppError when Google refuses (auth) or cannot be reached
 */
export async function mintLiveToken(apiKey: string, options: MintOptions = {}): Promise<LiveToken> {
  if (!apiKey.trim()) throw new AppError('auth', 'Voice needs a Gemini API key.');
  const now = options.now?.() ?? Date.now();
  const expiresAt = now + (options.sessionMs ?? SESSION_MS);
  const newSessionUntil = now + (options.startWithinMs ?? START_WITHIN_MS);
  const model = options.model?.trim();
  const body = await fetchJson<{ name?: string }>(AUTH_TOKENS_URL, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey.trim() },
    body: {
      uses: options.uses ?? 1,
      expireTime: new Date(expiresAt).toISOString(),
      newSessionExpireTime: new Date(newSessionUntil).toISOString(),
      ...(model
        ? { bidiGenerateContentSetup: { model: model.startsWith('models/') ? model : `models/${model}` } }
        : {}),
    },
    fetch: options.fetch,
    retryPolicy: options.retryPolicy,
  });
  if (typeof body?.name !== 'string' || !body.name.startsWith('auth_tokens/')) {
    throw new AppError('unknown', 'Google did not give a voice session token.');
  }
  return { token: body.name, endpoint: LIVE_CONSTRAINED_ENDPOINT, expiresAt, newSessionUntil };
}

/** The WebSocket address for a token. */
export function liveSocketUrl(token: Pick<LiveToken, 'token' | 'endpoint'>): string {
  return `${token.endpoint}?access_token=${encodeURIComponent(token.token)}`;
}

/** A token from the saved Gemini key, for the voice conversation and live captions. */
export async function liveTokenFromSettings(options: Omit<MintOptions, 'now'> = {}): Promise<LiveToken> {
  const providers = await llmProviderStore.getAllProviders();
  const gemini = Object.entries(providers).find(
    ([providerId, config]) =>
      (config.type ?? getProviderTypeByProviderId(providerId)) === ProviderTypeEnum.Gemini && config.apiKey,
  );
  if (!gemini) throw new AppError('auth', 'Voice needs a Gemini API key.');
  return mintLiveToken(gemini[1].apiKey, options);
}
