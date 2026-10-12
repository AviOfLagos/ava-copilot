/**
 * Model prices in USD per million tokens, used for the cost shown per chat and for the daily cap.
 * Source: https://ai.google.dev/gemini-api/docs/pricing (paid tier, standard), read 2026-10-02.
 * Other providers' prices come from the model registry (`priceCall`); local models cost nothing. A model
 * with no known price has its tokens counted, against their own daily cap, and no cost.
 */

export interface ModelPrice {
  model: string;
  // The first day this price applies, YYYY-MM-DD; unset means it always applied
  from?: string;
  input: number;
  output: number;
  // Prices for a prompt longer than `threshold` tokens
  long?: { threshold: number; input: number; output: number };
}

export const MODEL_PRICES: ModelPrice[] = [
  { model: 'gemini-3.8-flash', input: 0.75, output: 3.75 },
  { model: 'gemini-3.8-flash', from: '2027-01-01', input: 1.5, output: 7.5 },
  {
    model: 'gemini-3.1-pro-preview',
    input: 2,
    output: 12,
    long: { threshold: 200_000, input: 4, output: 18 },
  },
  { model: 'gemini-3.5-flash', input: 1.5, output: 9 },
  { model: 'gemini-3.5-flash-lite', input: 0.3, output: 2.5 },
  // Text input; embeddings have no output tokens (read 2026-10-03)
  { model: 'gemini-embedding-2', input: 0.2, output: 0 },
];

// Live API audio is billed by the minute (same source, read 2026-10-03). Replies are suppressed, so
// streamed input is the whole cost of live captions.
export const LIVE_AUDIO_USD_PER_MINUTE = 0.005;
// Spoken replies, for the voice conversation
export const LIVE_AUDIO_OUT_USD_PER_MINUTE = 0.018;

/**
 * Finds the price of a model on a given day.
 *
 * @param model - The model name as configured
 * @param day - The day of the call, YYYY-MM-DD
 * @returns The price, or null for a model with no known price
 */
export function priceFor(model: string, day: string, prices: ModelPrice[] = MODEL_PRICES): ModelPrice | null {
  const candidates = prices.filter(price => price.model === model && (price.from === undefined || price.from <= day));
  if (candidates.length === 0) {
    return null;
  }
  // The latest price that has started
  return candidates.reduce((latest, price) => ((price.from ?? '') >= (latest.from ?? '') ? price : latest));
}

/**
 * Prices one model call.
 *
 * @returns The cost in USD, or null for a model with no known price
 */
export function costOf(
  model: string,
  inputTokens: number,
  outputTokens: number,
  day: string,
  prices: ModelPrice[] = MODEL_PRICES,
): number | null {
  const price = priceFor(model, day, prices);
  if (price === null) {
    return null;
  }
  const rate = price.long && inputTokens > price.long.threshold ? price.long : price;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

/** One model call to price: which provider and model, how many tokens, on which day. */
export interface PricedCall {
  // The provider's id in the provider settings; unknown for callers that only name the model
  providerId?: string;
  // The provider's kind, when known
  providerType?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  day: string;
}

/** What the model registry knows of a model's price. */
export interface CatalogPrice {
  local: boolean;
  inputUsdPerM: number | null;
  outputUsdPerM: number | null;
}

/**
 * Prices a call from every source there is: local servers cost nothing; Gemini's own table (dated prices,
 * long-prompt rates) comes first for Gemini and for callers that name only the model; then the price the
 * registry found (OpenRouter lists one for every model). Anything else has no known price.
 *
 * @returns The cost in USD, or null when the price is not known
 */
export function priceCall(call: PricedCall, catalogEntry?: CatalogPrice | null): number | null {
  if (call.providerType === 'ollama' || call.providerType === 'lmstudio') return 0;
  if (!call.providerId || call.providerType === 'gemini') {
    const fromTable = costOf(call.model, call.inputTokens, call.outputTokens, call.day);
    if (fromTable !== null) return fromTable;
  }
  if (catalogEntry?.local) return 0;
  if (catalogEntry && catalogEntry.inputUsdPerM !== null && catalogEntry.outputUsdPerM !== null) {
    return (call.inputTokens * catalogEntry.inputUsdPerM + call.outputTokens * catalogEntry.outputUsdPerM) / 1_000_000;
  }
  return null;
}
