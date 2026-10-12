import { beforeEach, describe, expect, it, vi } from 'vitest';

// The storage modules read globalThis.chrome when they are imported
vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({}), set: async () => undefined, onChanged: { addListener: () => undefined } },
    },
  });
});

const { ProviderTypeEnum, TAG } = await import('@extension/storage');
const { AppError } = await import('@extension/shared');
const { listProviderModels, parseOpenRouterModels, perMillion, providerBaseUrl } = await import('../discovery');
const { fetchJson } = await import('../http');
const { resetBreakers } = await import('../breakers');
import { fakeFetch, networkDown, quickRetry } from './fakeFetch';
import type { DiscoveryTarget } from '../discovery';

const target = (
  type: (typeof ProviderTypeEnum)[keyof typeof ProviderTypeEnum],
  extra: Partial<DiscoveryTarget> = {},
) => ({
  providerId: type,
  type,
  apiKey: '',
  ...extra,
});

beforeEach(() => resetBreakers());

describe('OpenRouter', () => {
  const body = {
    data: [
      {
        id: 'anthropic/claude-opus-5-5',
        name: 'Anthropic: Claude Opus 5.5',
        context_length: 400000,
        architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
        pricing: { prompt: '0.000015', completion: '0.000075' },
        supported_parameters: ['tools', 'tool_choice', 'reasoning'],
      },
      {
        id: 'meta-llama/llama-4-scout:free',
        name: 'Llama 4 Scout (free)',
        context_length: 128000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['max_tokens'],
      },
      { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' } },
      {
        id: 'google/gemini-3.8-flash-image',
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] },
        pricing: { prompt: '0.0000003', completion: '0.0000025' },
      },
    ],
  };

  it('reads prices per million tokens, context, modalities and tool support', async () => {
    const { fetch, requests } = fakeFetch({ 'https://openrouter.ai/api/v1/models': { json: body } });
    const models = await listProviderModels(target(ProviderTypeEnum.OpenRouter, { apiKey: 'sk-or-1' }), { fetch });
    expect(requests[0].headers.get('authorization')).toBe('Bearer sk-or-1');

    const [opus, free, auto, image] = models;
    expect(opus).toMatchObject({
      model: 'anthropic/claude-opus-5-5',
      label: 'Anthropic: Claude Opus 5.5',
      contextTokens: 400000,
      inputUsdPerM: 15,
      outputUsdPerM: 75,
      tools: true,
    });
    expect(opus.modalities).toEqual(expect.arrayContaining([TAG.chat, TAG.text, TAG.image, TAG.file, TAG.reasoning]));
    expect(free).toMatchObject({ inputUsdPerM: 0, outputUsdPerM: 0, tools: false });
    // A router's price depends on where it routes: unknown
    expect(auto).toMatchObject({ inputUsdPerM: null, outputUsdPerM: null });
    expect(image.modalities).toContain(TAG.imageOutput);
    expect(image.inputUsdPerM).toBeCloseTo(0.3);
  });

  it('converts prices without float noise and treats junk as unknown', () => {
    expect(perMillion('0.0000003')).toBe(0.3);
    expect(perMillion('abc')).toBeNull();
    expect(perMillion(undefined)).toBeNull();
    expect(parseOpenRouterModels({ data: [{ id: '' }, {}] as never })).toEqual([]);
  });
});

describe('Ollama', () => {
  it('lists pulled models from the server root and asks each for its capabilities', async () => {
    const { fetch, requests } = fakeFetch({
      'http://localhost:11434/api/tags': {
        json: {
          models: [
            { name: 'qwen3.8:8b', details: { family: 'qwen3' } },
            { name: 'llava:13b', details: { family: 'llama', families: ['llama', 'clip'] } },
            { name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } },
          ],
        },
      },
      'http://localhost:11434/api/show': [
        { json: { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'qwen3.context_length': 40960 } } },
        { status: 500 },
        { json: { capabilities: ['embedding'] } },
      ],
    });
    const models = await listProviderModels(
      target(ProviderTypeEnum.Ollama, { apiKey: 'ollama', baseUrl: 'http://localhost:11434/v1' }),
      { fetch },
    );
    expect(requests[0].url).toBe('http://localhost:11434/api/tags');
    expect(requests.filter(request => request.url.endsWith('/api/show')).map(request => request.body)).toEqual([
      { model: 'qwen3.8:8b' },
      { model: 'llava:13b' },
      { model: 'nomic-embed-text:latest' },
    ]);
    expect(models[0]).toMatchObject({ model: 'qwen3.8:8b', contextTokens: 40960, tools: true, inputUsdPerM: 0 });
    expect(models[0].modalities).toEqual(expect.arrayContaining([TAG.chat, TAG.reasoning]));
    // Details failed: the name and family still say it sees images
    expect(models[1].modalities).toEqual(expect.arrayContaining([TAG.chat, TAG.image]));
    expect(models[2].modalities).toEqual([TAG.embedding, TAG.text]);
  });

  it('reports a refused origin as forbidden (status 403), the OLLAMA_ORIGINS case', async () => {
    const { fetch } = fakeFetch({ 'http://localhost:11434/api/tags': { status: 403 } });
    const error = await listProviderModels(target(ProviderTypeEnum.Ollama), { fetch }).catch(thrown => thrown);
    expect(AppError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ kind: 'forbidden', status: 403 });
  });
});

describe('OpenAI-compatible lists', () => {
  const list = (...ids: string[]) => ({ json: { object: 'list', data: ids.map(id => ({ id, object: 'model' })) } });

  it('asks LM Studio and NVIDIA NIM at their default addresses, with the key only when there is one', async () => {
    const { fetch, requests } = fakeFetch({
      'http://localhost:1234/v1/models': list('qwen2.5-vl-7b-instruct', 'text-embedding-nomic-embed-text-v1.5'),
      'https://integrate.api.nvidia.com/v1/models': list('meta/llama-3.3-70b-instruct', 'nvidia/nv-embedqa-e5-v5'),
    });
    const lmstudio = await listProviderModels(target(ProviderTypeEnum.LMStudio), { fetch });
    const nvidia = await listProviderModels(target(ProviderTypeEnum.Nvidia, { apiKey: 'nvapi-1' }), { fetch });
    expect(requests[0].headers.get('authorization')).toBeNull();
    expect(requests[1].headers.get('authorization')).toBe('Bearer nvapi-1');
    expect(lmstudio[0].modalities).toContain(TAG.image);
    expect(lmstudio[1].modalities).toEqual([TAG.embedding, TAG.text]);
    expect(nvidia.map(model => model.model)).toEqual(['meta/llama-3.3-70b-instruct', 'nvidia/nv-embedqa-e5-v5']);
    expect(nvidia[0].modalities).toContain(TAG.chat);
  });

  it('sorts out what OpenAI lists that is not a chat model', async () => {
    const { fetch } = fakeFetch({
      'https://api.openai.com/v1/models': list(
        'gpt-6-astra',
        'text-embedding-3-small',
        'whisper-1',
        'tts-1',
        'davinci-002',
        'dall-e-3',
      ),
    });
    const models = await listProviderModels(target(ProviderTypeEnum.OpenAI, { apiKey: 'sk-1' }), { fetch });
    const tags = Object.fromEntries(models.map(model => [model.model, model.modalities]));
    expect(tags['gpt-6-astra']).toEqual(expect.arrayContaining([TAG.chat, TAG.image]));
    expect(tags['text-embedding-3-small']).toContain(TAG.embedding);
    expect(tags['whisper-1']).toContain(TAG.transcription);
    expect(tags['tts-1']).toContain(TAG.speech);
    expect(tags['davinci-002']).not.toContain(TAG.chat);
    expect(tags['dall-e-3']).toContain(TAG.imageOutput);
  });

  it('asks xAI and DeepSeek at their own addresses, and a custom endpoint at its base URL', async () => {
    const { fetch, requests } = fakeFetch({
      'https://api.x.ai/v1/models': list('grok-4.7'),
      'https://api.deepseek.com/models': list('deepseek-flash', 'deepseek-v4-pro'),
      'https://llm.example.test/v1/models': {
        json: {
          data: [
            { id: 'served-model', max_model_len: 32768 },
            { id: 'bge-m3', type: 'embedding' },
          ],
        },
      },
    });
    expect((await listProviderModels(target(ProviderTypeEnum.Grok, { apiKey: 'xai' }), { fetch }))[0].model).toBe(
      'grok-4.7',
    );
    expect(await listProviderModels(target(ProviderTypeEnum.DeepSeek, { apiKey: 'ds' }), { fetch })).toHaveLength(2);
    const custom = await listProviderModels(
      target(ProviderTypeEnum.CustomOpenAI, { providerId: 'custom_openai_1', baseUrl: 'https://llm.example.test/v1/' }),
      { fetch },
    );
    expect(requests.map(request => request.url)).toEqual([
      'https://api.x.ai/v1/models',
      'https://api.deepseek.com/models',
      'https://llm.example.test/v1/models',
    ]);
    expect(custom[0]).toMatchObject({ model: 'served-model', contextTokens: 32768 });
    expect(custom[1].modalities).toEqual([TAG.embedding, TAG.text]);
    // No address, nothing to ask
    expect(await listProviderModels(target(ProviderTypeEnum.CustomOpenAI), { fetch })).toEqual([]);
  });

  it('lists Azure deployments as typed, without a call', async () => {
    const { fetch, requests } = fakeFetch({});
    const models = await listProviderModels(
      target(ProviderTypeEnum.AzureOpenAI, { azureDeploymentNames: ['gpt-5', 'gpt-5-mini'] }),
      { fetch },
    );
    expect(models.map(model => model.model)).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(requests).toHaveLength(0);
  });
});

describe('Anthropic', () => {
  it('sends its key, version and the browser opt-in, and follows pages', async () => {
    const { fetch, requests } = fakeFetch({
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5': {
        json: { data: [{ id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' }], has_more: false },
      },
      'https://api.anthropic.com/v1/models?limit=1000': {
        json: {
          data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 500000 }],
          has_more: true,
          last_id: 'claude-opus-5-5',
        },
      },
    });
    const models = await listProviderModels(target(ProviderTypeEnum.Anthropic, { apiKey: 'sk-ant-1' }), { fetch });
    expect(requests[0].headers.get('x-api-key')).toBe('sk-ant-1');
    expect(requests[0].headers.get('anthropic-version')).toBe('2023-06-01');
    expect(requests[0].headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(models.map(model => model.label)).toEqual(['Claude Opus 5.5', 'Claude Haiku 4.5']);
    expect(models[0]).toMatchObject({ contextTokens: 500000, tools: true });
    expect(models[0].modalities).toEqual(expect.arrayContaining([TAG.chat, TAG.image]));
  });
});

describe('Gemini', () => {
  it('sends the key in a header, never the address, and reads what each model supports', async () => {
    const { fetch, requests } = fakeFetch({
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=p2': {
        json: {
          models: [{ name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] }],
        },
      },
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000': {
        json: {
          models: [
            {
              name: 'models/gemini-3.8-flash',
              displayName: 'Gemini 3.8 Flash',
              inputTokenLimit: 1048576,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            },
            { name: 'models/gemini-live-3-flash', supportedGenerationMethods: ['bidiGenerateContent'] },
            { name: 'models/gemini-3.5-flash-tts', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
          ],
          nextPageToken: 'p2',
        },
      },
    });
    const models = await listProviderModels(target(ProviderTypeEnum.Gemini, { apiKey: 'AIza-key' }), { fetch });
    expect(requests[0].headers.get('x-goog-api-key')).toBe('AIza-key');
    expect(requests.every(request => !request.url.includes('AIza-key'))).toBe(true);
    expect(models.map(model => model.model)).toEqual([
      'gemini-3.8-flash',
      'gemini-live-3-flash',
      'gemini-3.5-flash-tts',
      'gemini-embedding-2',
    ]);
    expect(models[0]).toMatchObject({ label: 'Gemini 3.8 Flash', contextTokens: 1048576, tools: true });
    expect(models[0].modalities).toEqual(expect.arrayContaining([TAG.chat, TAG.image, TAG.audio, TAG.search]));
    expect(models[1].modalities).toContain(TAG.live);
    expect(models[2].modalities).toContain(TAG.speech);
    expect(models[2].modalities).not.toContain(TAG.chat);
    expect(models[3].modalities).toEqual([TAG.embedding, TAG.text]);
  });
});

describe('fetchJson: retries, timeouts and the circuit breaker', () => {
  it('retries an outage and a rate limit, then succeeds', async () => {
    const { fetch, requests } = fakeFetch({
      'https://api.x.ai/v1/models': [
        { status: 503 },
        { status: 429, headers: { 'retry-after': '0' } },
        { json: { data: [{ id: 'grok-4.7' }] } },
      ],
    });
    const models = await listProviderModels(target(ProviderTypeEnum.Grok, { apiKey: 'x' }), {
      fetch,
      retryPolicy: quickRetry,
    });
    expect(models).toHaveLength(1);
    expect(requests).toHaveLength(3);
  });

  it('does not retry a refused key', async () => {
    const { fetch, requests } = fakeFetch({ 'https://api.x.ai/v1/models': { status: 401 } });
    const error = await listProviderModels(target(ProviderTypeEnum.Grok, { apiKey: 'bad' }), {
      fetch,
      retryPolicy: quickRetry,
    }).catch(thrown => thrown);
    expect(error).toMatchObject({ kind: 'auth', status: 401 });
    expect(requests).toHaveLength(1);
  });

  it('gives up on a host that keeps failing, and fails fast until it cools down', async () => {
    const { fetch, requests } = fakeFetch({ 'https://down.example.test/': networkDown });
    const call = () =>
      fetchJson('https://down.example.test/v1/models', { fetch, retry: false }).catch(thrown => thrown);
    for (let attempt = 0; attempt < 5; attempt++) expect(await call()).toMatchObject({ kind: 'network' });
    expect(requests).toHaveLength(5);
    expect(await call()).toMatchObject({ kind: 'unavailable', retryable: false });
    expect(requests).toHaveLength(5);
  });

  it('times out a provider that does not answer', async () => {
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    ) as unknown as typeof globalThis.fetch;
    const error = await fetchJson('https://slow.example.test/v1/models', { fetch, retry: false, timeoutMs: 20 }).catch(
      thrown => thrown,
    );
    expect(error).toMatchObject({ kind: 'timeout' });
  });

  it('knows each provider kind’s address', () => {
    expect(providerBaseUrl(ProviderTypeEnum.Ollama, 'http://localhost:11434/v1/')).toBe('http://localhost:11434');
    expect(providerBaseUrl(ProviderTypeEnum.Grok, 'https://ignored.test')).toBe('https://api.x.ai/v1');
    expect(providerBaseUrl(ProviderTypeEnum.CustomOpenAI)).toBeNull();
  });
});
