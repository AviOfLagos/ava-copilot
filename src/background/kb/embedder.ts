import { embedMany } from 'ai';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { llmProviderStore, ProviderTypeEnum } from '@extension/storage';
import { getOllamaBaseUrl } from '../llm/providers';
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

/** Nomic's embedding models take their task as a prefix. */
export function localEmbeddingInput(text: string, kind: 'query' | 'document', title?: string): string {
  return kind === 'query' ? `search_query: ${text}` : `search_document: ${title ? `${title}. ` : ''}${text}`;
}

/** The name stored with each vector, so vectors from different models are never compared. */
export const localModelId = (name: string) => `ollama:${name}`;

/**
 * The embedding model: Gemini with the configured key, or a local Ollama server, which costs
 * nothing and never runs out. On "auto", Gemini when there is a key, Ollama otherwise. With neither,
 * the knowledge base still works, by keywords only.
 *
 * @param sessionId - Where the cost of Gemini embeddings is counted
 */
export async function createEmbedder(settings: KbSettingsConfig, sessionId: string): Promise<Embedder | null> {
  const providers = Object.entries(await llmProviderStore.getAllProviders());
  const gemini = providers.find(([id, provider]) => (provider.type ?? id) === 'gemini' && provider.apiKey);
  const ollama = providers.find(([id, provider]) => (provider.type ?? id) === ProviderTypeEnum.Ollama);
  const source = settings.embedSource ?? 'auto';
  const useLocal = source === 'local' || (source === 'auto' && !gemini && ollama);

  if (useLocal) {
    if (!ollama) return null;
    const local = createOpenAI({ apiKey: ollama[1].apiKey || 'ollama', baseURL: getOllamaBaseUrl(ollama[1].baseUrl) });
    const name = settings.localEmbedModel || 'nomic-embed-text';
    const model = local.embedding(name);
    return {
      model: localModelId(name),
      async embed(texts, kind, titles) {
        const vectors: number[][] = [];
        for (let start = 0; start < texts.length; start += BATCH) {
          const values = texts
            .slice(start, start + BATCH)
            .map((text, index) => localEmbeddingInput(text, kind, titles?.[start + index]));
          const result = await embedMany({ model, values, maxRetries: 2 });
          vectors.push(...result.embeddings.map(vector => normalize(vector)));
        }
        return vectors;
      },
    };
  }

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
