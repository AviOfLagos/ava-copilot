import {
  AgentNameEnum,
  agentModelStore,
  db,
  getProviderTypeByProviderId,
  isLocalProvider,
  llmProviderStore,
  meetingSettingsStore,
  modelHealthStore,
  ProviderTypeEnum,
  speechToTextModelStore,
  voiceEngineSettingsStore,
} from '@extension/storage';
import type { ProviderConfig } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { createChatModel } from '../llm/providers';
import { generatePlainText } from '../llm/generate';
import { userMessage } from '../llm/messages';
import { discoveryHost } from '../models/discovery';
import { openHosts } from '../models/breakers';
import { liveTokenFromSettings, usesLiveTokens } from '../models/liveToken';
import { classifyError } from './model-check';
import type { ModelOption, ModelProbe, ModelUse } from './model-check';

/**
 * The live half of check_model: one tiny request per model in use, and what could stand in for each. The rules that
 * decide what to recommend are in ./model-check.ts.
 */

const PING_TIMEOUT_MS = 15_000;

async function pingChat(use: ModelUse, providerId: string, model: string): Promise<ModelProbe> {
  const base = { use, providerId, model };
  const provider = await llmProviderStore.getProvider(providerId).catch(() => undefined);
  if (!provider) return { ...base, ok: false, latencyMs: null, errorKind: 'not_set', error: 'Its provider is gone.' };
  const started = Date.now();
  try {
    const chatModel = createChatModel(provider, { provider: providerId, modelName: model });
    // A word or two back: the cheapest call that proves the model answers
    await generatePlainText({
      chatModel: { ...chatModel, settings: { ...chatModel.settings, maxOutputTokens: 16 } },
      messages: [userMessage('Reply with the single word OK.')],
      abortSignal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return { ...base, ok: true, latencyMs: Date.now() - started, errorKind: null, error: null };
  } catch (error) {
    return {
      ...base,
      ok: false,
      latencyMs: Date.now() - started,
      errorKind: classifyError(error),
      error: toAppError(error).message.slice(0, 160),
    };
  }
}

/** Opens a Live socket, sends the setup, and waits for setupComplete: the voice model answers. */
async function pingLive(voiceRunning: boolean): Promise<ModelProbe> {
  const [settings, engines, providers] = await Promise.all([
    meetingSettingsStore.getSettings(),
    voiceEngineSettingsStore.getSettings(),
    llmProviderStore.getAllProviders(),
  ]);
  const base = { use: 'voice' as const, providerId: 'gemini', model: settings.liveModel };
  if (engines.mode === 'economy') {
    return {
      ...base,
      model: 'economy voice',
      ok: true,
      latencyMs: null,
      errorKind: null,
      error: null,
      note: 'economy mode: speech is recognised on this computer and the chat model answers.',
    };
  }
  if (voiceRunning) {
    return {
      ...base,
      ok: true,
      latencyMs: null,
      errorKind: null,
      error: null,
      note: 'working: this conversation runs on it now.',
    };
  }
  const gemini = Object.entries(providers).find(([id, p]) => (p.type ?? id) === 'gemini' && p.apiKey);
  if (!gemini) return { ...base, ok: false, latencyMs: null, errorKind: 'not_set', error: 'No Gemini key.' };
  const started = Date.now();
  try {
    const url = usesLiveTokens(settings.liveEndpoint)
      ? await liveTokenFromSettings().then(token => `${token.endpoint}?access_token=${encodeURIComponent(token.token)}`)
      : `${settings.liveEndpoint}?key=${encodeURIComponent(gemini[1].apiKey)}`;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('timed out'));
      }, PING_TIMEOUT_MS);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolve();
      };
      socket.onopen = () => socket.send(JSON.stringify({ setup: { model: `models/${settings.liveModel}` } }));
      socket.onmessage = async event => {
        const raw = typeof event.data === 'string' ? event.data : await (event.data as Blob).text();
        if (raw.includes('setupComplete')) finish();
      };
      socket.onerror = () => finish(new Error('connection failed'));
      socket.onclose = event => {
        if (event.code !== 1000 && event.code !== 1005) finish(new Error(event.reason || `closed (${event.code})`));
      };
    });
    return { ...base, ok: true, latencyMs: Date.now() - started, errorKind: null, error: null };
  } catch (error) {
    return {
      ...base,
      ok: false,
      latencyMs: Date.now() - started,
      errorKind: classifyError(error),
      error: toAppError(error).message.slice(0, 160),
    };
  }
}

/** One probe per model in use: the chat agent's model, voice, and speech-to-text. */
export async function probeModels(voiceRunning: boolean): Promise<ModelProbe[]> {
  const [navigator, speech] = await Promise.all([
    agentModelStore.getAgentModel(AgentNameEnum.Navigator),
    speechToTextModelStore.getSpeechToTextModel(),
  ]);
  const notSet = (use: ModelUse): ModelProbe => ({
    use,
    providerId: null,
    model: null,
    ok: false,
    latencyMs: null,
    errorKind: 'not_set',
    error: null,
  });
  return Promise.all([
    navigator ? pingChat('chat', navigator.provider, navigator.modelName) : notSet('chat'),
    pingLive(voiceRunning),
    speech ? pingChat('speech', speech.provider, speech.modelName) : notSet('speech'),
  ]);
}

/** Every configured model that could stand in, from the catalog (else the provider's chosen names). */
export async function modelOptions(): Promise<{ options: ModelOption[]; extra: string[] }> {
  const [providers, catalog, health, down] = await Promise.all([
    llmProviderStore.getProviderSummaries(),
    db.modelCatalog.toArray(),
    modelHealthStore.getHealth(),
    openHosts(),
  ]);
  const options: ModelOption[] = [];
  for (const [providerId, config] of Object.entries(providers) as [string, ProviderConfig][]) {
    const type = config.type ?? getProviderTypeByProviderId(providerId);
    const host = discoveryHost(type, config.baseUrl);
    const common = {
      providerId,
      providerName: config.name || providerId,
      local: isLocalProvider(config),
      health: health.providers[providerId]?.status ?? 'unknown',
      down: host !== null && down.has(host),
    };
    const listed = catalog.filter(entry => entry.providerId === providerId && entry.health !== 'error');
    if (listed.length) {
      for (const entry of listed) options.push({ ...common, model: entry.model, tags: entry.modalities });
    } else {
      // Gemini models hear audio, so they can transcribe; others are assumed to chat
      const tags = type === ProviderTypeEnum.Gemini ? ['chat', 'audio'] : ['chat'];
      for (const model of config.modelNames ?? []) options.push({ ...common, model, tags });
    }
  }
  // A local server found but never added: worth saying, it cannot be switched to yet
  const extra = Object.values(health.local)
    .filter(probe => probe?.status === 'found' && !options.some(option => option.local))
    .map(
      probe =>
        `${probe!.kind === 'ollama' ? 'Ollama' : 'LM Studio'} is running on this computer with ${probe!.models.length} models, but it is not added yet: add it in Models & usage to use it.`,
    );
  return { options, extra };
}
