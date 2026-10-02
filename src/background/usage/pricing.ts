/**
 * Model prices in USD per million tokens, used for the cost shown per chat and for the daily cap.
 * Source: https://ai.google.dev/gemini-api/docs/pricing (paid tier, standard), read 2026-10-02.
 * A model that is not listed has no known price: its tokens are counted and its cost is not.
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
];

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
