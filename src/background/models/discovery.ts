import {
  LM_STUDIO_BASE_URL,
  NVIDIA_BASE_URL,
  OLLAMA_BASE_URL,
  OPENROUTER_BASE_URL,
  ProviderTypeEnum,
  providerTags,
  TAG,
  tagsFromName,
  withTags,
} from '@extension/storage';
import type { RetryPolicy } from '@extension/shared';
import { fetchJson } from './http';

/**
 * Asks each kind of provider which models it offers, and reads what it says about them: names, context
 * length, prices, what goes in and comes out, tool use. One function per response shape, so each is tested
 * against a recorded answer.
 */

/** A model as a provider lists it, before it is placed in the catalog. */
export interface DiscoveredModel {
  model: string;
  label: string;
  contextTokens: number | null;
  // US dollars per million tokens, when the provider says
  inputUsdPerM: number | null;
  outputUsdPerM: number | null;
  modalities: string[];
  tools: boolean | null;
}

/** What discovery needs of a provider: the decrypted key stays in the background. */
export interface DiscoveryTarget {
  providerId: string;
  type: ProviderTypeEnum;
  apiKey: string;
  baseUrl?: string;
  azureDeploymentNames?: string[];
}

export interface DiscoveryOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  retryPolicy?: Partial<RetryPolicy>;
}

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const XAI_BASE_URL = 'https://api.x.ai/v1';
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
// The local servers looked for on first run
export const OLLAMA_LOCAL_URL = 'http://localhost:11434';
export const LM_STUDIO_LOCAL_URL = LM_STUDIO_BASE_URL;

// Pages followed at most, for providers that page their list
const MAX_PAGES = 5;
// Ollama models asked about in detail (capabilities, context length)
const MAX_OLLAMA_DETAILS = 40;

const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');
const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;

/** The Ollama server's own address, from the OpenAI-compatible base URL saved with the provider. */
export function ollamaRoot(baseUrl?: string): string {
  return trimSlash(baseUrl?.trim() || OLLAMA_BASE_URL).replace(/\/v1$/, '');
}

const bearer = (apiKey: string): Record<string, string> =>
  apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {};

/**
 * Where a provider's model list is read from. xAI and DeepSeek configs carry no address (their SDKs use
 * their own); Ollama lists at the server's root, not its OpenAI-compatible /v1.
 */
export function providerBaseUrl(type: ProviderTypeEnum, baseUrl?: string): string | null {
  const base = baseUrl?.trim() ? trimSlash(baseUrl) : '';
  switch (type) {
    case ProviderTypeEnum.Anthropic:
      return base || ANTHROPIC_BASE_URL;
    case ProviderTypeEnum.Gemini:
      return base || GEMINI_BASE_URL;
    case ProviderTypeEnum.Ollama:
      return ollamaRoot(baseUrl);
    case ProviderTypeEnum.OpenRouter:
      return base || OPENROUTER_BASE_URL;
    case ProviderTypeEnum.Grok:
      return XAI_BASE_URL;
    case ProviderTypeEnum.DeepSeek:
      return DEEPSEEK_BASE_URL;
    case ProviderTypeEnum.OpenAI:
      return base || OPENAI_BASE_URL;
    case ProviderTypeEnum.Nvidia:
      return base || NVIDIA_BASE_URL;
    case ProviderTypeEnum.LMStudio:
      return base || LM_STUDIO_BASE_URL;
    default:
      return base || null;
  }
}

/** The host a provider's model list comes from, for its circuit breaker; null when it has no address. */
export function discoveryHost(type: ProviderTypeEnum, baseUrl?: string): string | null {
  const url = providerBaseUrl(type, baseUrl);
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// ── Response shapes ───────────────────────────────────────────────────────────────────────────────

interface OpenAIModelList {
  data?: {
    id?: string;
    // vLLM, Groq, Together and others add these
    max_model_len?: number;
    context_window?: number;
    context_length?: number;
    type?: string;
  }[];
}

// OpenAI's own list mixes in models the chat API does not serve
const OPENAI_COMPLETION_ONLY = /^(babbage|davinci)|gpt-3\.5-turbo-instruct|computer-use|codex-mini/;

/** An OpenAI-compatible `/models` answer (OpenAI, NVIDIA, LM Studio, xAI, DeepSeek, any custom endpoint). */
export function parseOpenAIModels(body: OpenAIModelList, type: ProviderTypeEnum): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  for (const item of body?.data ?? []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    let tags = providerTags(type, tagsFromName(id));
    // Some servers say what kind of model it is
    switch (item.type) {
      case 'embedding':
      case 'embeddings':
        tags = [TAG.embedding, TAG.text];
        break;
      case 'vlm':
        tags = withTags(tags, TAG.image);
        break;
      case 'rerank':
        tags = [TAG.rerank, TAG.text];
        break;
      case 'moderation':
        tags = [TAG.moderation, TAG.text];
        break;
      case 'image':
        tags = [TAG.imageOutput, TAG.text];
        break;
    }
    if (type === ProviderTypeEnum.OpenAI && OPENAI_COMPLETION_ONLY.test(id)) {
      tags = tags.filter(tag => tag !== TAG.chat);
    }
    models.push({
      model: id,
      label: id,
      contextTokens: positive(item.context_length) ?? positive(item.context_window) ?? positive(item.max_model_len),
      inputUsdPerM: null,
      outputUsdPerM: null,
      modalities: tags,
      tools: null,
    });
  }
  return models;
}

interface OpenRouterModelList {
  data?: {
    id?: string;
    name?: string;
    context_length?: number;
    architecture?: { input_modalities?: string[]; output_modalities?: string[] };
    pricing?: { prompt?: string | number; completion?: string | number };
    top_provider?: { context_length?: number };
    supported_parameters?: string[];
  }[];
}

/** A price per token as OpenRouter gives it ("0.000003"), per million; negative means "varies", so unknown. */
export function perMillion(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const perToken = Number(value);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  return Math.round(perToken * 1_000_000 * 1e6) / 1e6;
}

/** OpenRouter's `/models`: prices, context, modalities and supported parameters for every model it routes to. */
export function parseOpenRouterModels(body: OpenRouterModelList): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  for (const item of body?.data ?? []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    const inputs = item.architecture?.input_modalities;
    const outputs = item.architecture?.output_modalities;
    const parameters = item.supported_parameters ?? [];
    let tags: string[];
    if (inputs?.length || outputs?.length) {
      const named = tagsFromName(id);
      tags = withTags(
        (inputs ?? ['text']).filter(input => ['text', 'image', 'audio', 'video', 'file'].includes(input)),
        (outputs ?? ['text']).includes('text') && !named.includes(TAG.embedding) && TAG.chat,
        (outputs ?? []).includes('image') && TAG.imageOutput,
        (outputs ?? []).includes('audio') && TAG.speech,
        named.includes(TAG.embedding) && TAG.embedding,
        named.includes(TAG.search) && TAG.search,
        (parameters.includes('reasoning') || parameters.includes('include_reasoning')) && TAG.reasoning,
      );
    } else {
      tags = tagsFromName(id);
    }
    models.push({
      model: id,
      label: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
      contextTokens: positive(item.context_length) ?? positive(item.top_provider?.context_length),
      inputUsdPerM: perMillion(item.pricing?.prompt),
      outputUsdPerM: perMillion(item.pricing?.completion),
      modalities: tags,
      tools: parameters.length ? parameters.includes('tools') : null,
    });
  }
  return models;
}

interface AnthropicModelList {
  data?: { id?: string; display_name?: string; max_input_tokens?: number }[];
  has_more?: boolean;
  last_id?: string;
}

/** Anthropic's `/v1/models`: every Claude model takes text and images and calls tools. */
export function parseAnthropicModels(body: AnthropicModelList): DiscoveredModel[] {
  return (body?.data ?? [])
    .filter(item => typeof item?.id === 'string' && item.id.trim())
    .map(item => ({
      model: item.id!.trim(),
      label: item.display_name?.trim() || item.id!.trim(),
      contextTokens: positive(item.max_input_tokens),
      inputUsdPerM: null,
      outputUsdPerM: null,
      modalities: withTags(tagsFromName(item.id!), TAG.chat, TAG.text, TAG.image),
      tools: true,
    }));
}

interface GeminiModelList {
  models?: {
    name?: string;
    displayName?: string;
    inputTokenLimit?: number;
    supportedGenerationMethods?: string[];
  }[];
  nextPageToken?: string;
}

/** Gemini's `/v1beta/models`: what each model supports decides what it is (chat, embedding, Live). */
export function parseGeminiModels(body: GeminiModelList): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  for (const item of body?.models ?? []) {
    const id = typeof item?.name === 'string' ? item.name.replace(/^models\//, '').trim() : '';
    if (!id) continue;
    const methods = item.supportedGenerationMethods ?? [];
    const named = tagsFromName(id);
    let tags: string[] = [];
    if (methods.includes('embedContent') || methods.includes('embedText')) {
      tags = [TAG.embedding, TAG.text];
    } else if (methods.includes('generateContent')) {
      if (named.includes(TAG.speech) || named.includes(TAG.imageOutput)) tags = named;
      else tags = providerTags(ProviderTypeEnum.Gemini, withTags(named, TAG.chat, TAG.text));
    } else if (methods.includes('predict')) {
      tags = [TAG.imageOutput, TAG.text];
    }
    if (methods.includes('bidiGenerateContent')) tags = withTags(tags, TAG.live, TAG.audio, TAG.text);
    if (tags.length === 0) continue;
    models.push({
      model: id,
      label: item.displayName?.trim() || id,
      contextTokens: positive(item.inputTokenLimit),
      inputUsdPerM: null,
      outputUsdPerM: null,
      modalities: tags,
      tools: tags.includes(TAG.chat) ? true : null,
    });
  }
  return models;
}

interface OllamaTags {
  models?: { name?: string; model?: string; details?: { family?: string; families?: string[] | null } }[];
}

/** Ollama's `/api/tags`: the models pulled on this machine. */
export function parseOllamaTags(body: OllamaTags): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  for (const item of body?.models ?? []) {
    const id =
      (typeof item?.name === 'string' && item.name.trim()) || (typeof item?.model === 'string' && item.model.trim());
    if (!id) continue;
    const families = [item.details?.family, ...(item.details?.families ?? [])].filter(Boolean).map(String);
    let tags = tagsFromName(id);
    if (families.some(family => /bert/.test(family))) tags = [TAG.embedding, TAG.text];
    else if (families.some(family => /clip|mllama|vision/.test(family))) tags = withTags(tags, TAG.image);
    models.push({
      model: id,
      label: id,
      contextTokens: null,
      inputUsdPerM: 0,
      outputUsdPerM: 0,
      modalities: tags,
      tools: null,
    });
  }
  return models;
}

interface OllamaShow {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

/** Ollama's `/api/show` says what a model can do and how long its context is. */
export function applyOllamaDetails(model: DiscoveredModel, details: OllamaShow): DiscoveredModel {
  const capabilities = details?.capabilities ?? [];
  const info = details?.model_info ?? {};
  const contextKey = Object.keys(info).find(key => key.endsWith('.context_length'));
  const contextTokens = contextKey ? positive(info[contextKey]) : null;
  if (capabilities.length === 0) return { ...model, contextTokens: contextTokens ?? model.contextTokens };
  const tags = capabilities.includes('embedding')
    ? [TAG.embedding, TAG.text]
    : withTags(
        [TAG.text],
        capabilities.includes('completion') && TAG.chat,
        capabilities.includes('vision') && TAG.image,
        capabilities.includes('thinking') && TAG.reasoning,
      );
  return {
    ...model,
    contextTokens: contextTokens ?? model.contextTokens,
    modalities: tags,
    tools: capabilities.includes('tools'),
  };
}

// ── Listing ───────────────────────────────────────────────────────────────────────────────────────

/** The models one provider offers. Throws an AppError when the provider cannot be reached or refuses. */
export async function listProviderModels(
  target: DiscoveryTarget,
  options: DiscoveryOptions = {},
): Promise<DiscoveredModel[]> {
  const call = <T>(
    url: string,
    init: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: unknown } = {},
  ) => fetchJson<T>(url, { ...init, signal: options.signal, fetch: options.fetch, retryPolicy: options.retryPolicy });
  const base = providerBaseUrl(target.type, target.baseUrl);

  switch (target.type) {
    case ProviderTypeEnum.AzureOpenAI:
      // Azure has deployments, not a model list: they are what the user entered
      return (target.azureDeploymentNames ?? []).map(name => ({
        model: name,
        label: name,
        contextTokens: null,
        inputUsdPerM: null,
        outputUsdPerM: null,
        modalities: tagsFromName(name),
        tools: null,
      }));

    case ProviderTypeEnum.Anthropic: {
      const models: DiscoveredModel[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `${base}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
        const body = await call<AnthropicModelList>(url, {
          headers: {
            'x-api-key': target.apiKey.trim(),
            'anthropic-version': '2023-06-01',
            // The service worker sends an Origin header, so Anthropic asks for this opt-in (as providers.ts)
            'anthropic-dangerous-direct-browser-access': 'true',
          },
        });
        models.push(...parseAnthropicModels(body));
        if (!body?.has_more || !body.last_id) break;
        after = body.last_id;
      }
      return models;
    }

    case ProviderTypeEnum.Gemini: {
      const models: DiscoveredModel[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        // The key goes in a header, never in the address
        const url = `${base}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const body = await call<GeminiModelList>(url, { headers: { 'x-goog-api-key': target.apiKey.trim() } });
        models.push(...parseGeminiModels(body));
        if (!body?.nextPageToken) break;
        pageToken = body.nextPageToken;
      }
      return models;
    }

    case ProviderTypeEnum.Ollama: {
      const root = base ?? ollamaRoot(target.baseUrl);
      const listed = parseOllamaTags(await call<OllamaTags>(`${root}/api/tags`));
      // Details are a bonus: one that fails keeps what the name says
      const detailed: DiscoveredModel[] = [];
      for (let start = 0; start < listed.length; start += 4) {
        const batch = listed.slice(start, start + 4);
        detailed.push(
          ...(await Promise.all(
            batch.map(async (model, index) => {
              if (start + index >= MAX_OLLAMA_DETAILS) return model;
              try {
                const details = await fetchJson<OllamaShow>(`${root}/api/show`, {
                  method: 'POST',
                  body: { model: model.model },
                  retry: false,
                  timeoutMs: 5000,
                  signal: options.signal,
                  fetch: options.fetch,
                });
                return applyOllamaDetails(model, details);
              } catch {
                return model;
              }
            }),
          )),
        );
      }
      return detailed;
    }

    case ProviderTypeEnum.OpenRouter:
      return parseOpenRouterModels(
        await call<OpenRouterModelList>(`${base}/models`, { headers: bearer(target.apiKey) }),
      );

    default: {
      // OpenAI, xAI, DeepSeek, NVIDIA, LM Studio and any OpenAI-compatible endpoint
      if (!base) return [];
      return parseOpenAIModels(
        await call<OpenAIModelList>(`${base}/models`, { headers: bearer(target.apiKey) }),
        target.type,
      );
    }
  }
}
