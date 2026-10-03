import { embedMany } from 'ai';
import { createGoogle } from '@ai-sdk/google';
import { llmProviderStore } from '@extension/storage';
import type { KbSettingsConfig } from '@extension/storage';
import { recordUsage } from '../usage/meter';
import { normalize } from './search';

// Texts per embedding request
const BATCH = 50;

export interface Embedder {
  model: string;
  /**
   * Embeds texts as unit vectors. Documents carry their title; queries are marked as searches,
   * which is how gemini-embedding-2 takes the task it would otherwise get as a task type.
   */
  embed(texts: string[], kind: 'query' | 'document', titles?: string[]): Promise<number[][]>;
}

export function embeddingInput(text: string, kind: 'query' | 'document', title?: string): string {
  return kind === 'query' ? `task: search result | query: ${text}` : `title: ${title || 'none'} | text: ${text}`;
}

/**
 * The Gemini embedding model, with the key of the configured Gemini provider. Without one the
 * knowledge base still works, by keywords only.
 *
 * @param sessionId - Where the cost of embedding is counted
 */
export async function createEmbedder(settings: KbSettingsConfig, sessionId: string): Promise<Embedder | null> {
  const providers = await llmProviderStore.getAllProviders();
  const gemini = Object.entries(providers).find(
    ([id, provider]) => (provider.type ?? id) === 'gemini' && provider.apiKey,
  );
  if (!gemini) {
    return null;
  }
  const google = createGoogle({ apiKey: gemini[1].apiKey, baseURL: gemini[1].baseUrl || undefined });
  const model = google.embeddingModel(settings.embedModel);

  return {
    model: settings.embedModel,
    async embed(texts, kind, titles) {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += BATCH) {
        const values = texts
          .slice(start, start + BATCH)
          .map((text, index) => embeddingInput(text, kind, titles?.[start + index]));
        const result = await embedMany({
          model,
          values,
          maxRetries: 3,
          providerOptions: { google: { outputDimensionality: settings.embedDimensions } },
        });
        vectors.push(...result.embeddings.map(vector => normalize(vector)));
        // The API does not always report tokens; about four characters make one
        const tokens = result.usage?.tokens || Math.ceil(values.join('').length / 4);
        await recordUsage(sessionId, settings.embedModel, tokens, 0).catch(() => {});
      }
      return vectors;
    },
  };
}
