import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StorageModule from '@extension/storage';
import { DEFAULT_KB_SETTINGS } from '@extension/storage';

let providers: Record<string, { type?: string; apiKey: string; baseUrl?: string; name: string }> = {};
vi.mock('@extension/storage', async original => ({
  ...(await original<typeof StorageModule>()),
  llmProviderStore: { getAllProviders: async () => providers },
}));
// The real providers module pulls in the browser automation
vi.mock('../../llm/providers', () => ({ getOllamaBaseUrl: (url?: string) => url ?? 'http://localhost:11434/v1' }));

const { createEmbedder, localEmbeddingInput, localModelId } = await import('../embedder');

const gemini = { type: 'gemini', apiKey: 'key', name: 'Gemini' };
const ollama = { type: 'ollama', apiKey: '', name: 'Ollama' };

describe('createEmbedder', () => {
  beforeEach(() => {
    providers = {};
  });

  it('uses Gemini when it has a key, on auto', async () => {
    providers = { gemini, ollama };
    expect((await createEmbedder(DEFAULT_KB_SETTINGS, 's'))?.model).toBe('gemini-embedding-2');
  });

  it('falls back to the local model without a Gemini key', async () => {
    providers = { ollama };
    expect((await createEmbedder(DEFAULT_KB_SETTINGS, 's'))?.model).toBe(localModelId('nomic-embed-text'));
  });

  it('uses the local model when chosen, even with a Gemini key', async () => {
    providers = { gemini, ollama };
    const embedder = await createEmbedder({ ...DEFAULT_KB_SETTINGS, embedSource: 'local' }, 's');
    expect(embedder?.model).toBe('ollama:nomic-embed-text');
  });

  it('has nothing to embed with when the chosen source is missing', async () => {
    providers = { gemini };
    expect(await createEmbedder({ ...DEFAULT_KB_SETTINGS, embedSource: 'local' }, 's')).toBeNull();
    providers = {};
    expect(await createEmbedder(DEFAULT_KB_SETTINGS, 's')).toBeNull();
  });
});

describe('localEmbeddingInput', () => {
  it('prefixes the task the way nomic-embed-text expects', () => {
    expect(localEmbeddingInput('stage 2', 'query')).toBe('search_query: stage 2');
    expect(localEmbeddingInput('Friday.', 'document', 'Sync')).toBe('search_document: Sync. Friday.');
  });
});
