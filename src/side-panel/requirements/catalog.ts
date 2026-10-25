import { t } from '@extension/i18n';
import {
  getProviderTypeByProviderId,
  isLocalProvider,
  kbSettingsStore,
  llmProviderStore,
  ProviderTypeEnum,
} from '@extension/storage';
import type { InstalledVoiceModels, ProviderConfig, VoiceModelId } from '@extension/storage';
import { brainSettingsStore } from '@src/background/companion/state';
import { settingsPageUrl } from '@src/shared/lib/settings-page';
import type { PanelApi } from '../registry';
import { BRAVE_FLAG_URL, vaultSupport } from '../vault/vault';
import { bytesFor, cancelDownload, downloadState, startDownload, subscribeDownloads } from '../voice-models/downloads';
import type { Requirement } from './flow';
import { hasOllamaModel, listOllamaModels, ollamaRoot, pullOllamaModel } from './ollama';

/**
 * Everything a setting can need installed, as requirements for `createRequirementFlow`. Each reads whether it is
 * ready from the source that uses it (the background's voice model list, the Ollama server, the pairing), so the
 * card never says ready when the feature would still fail.
 */

type Request = PanelApi['request'];

export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
// A small chat model for economy voice and light work when nothing local has one yet (recommend.ts' light pick)
export const DEFAULT_LOCAL_CHAT_MODEL = 'qwen3:4b';
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

const VOICE_MODEL_NAMES: Record<VoiceModelId, Parameters<typeof t>[0]> = {
  'moonshine-tiny': 'voice_engine_model_moonshineTiny',
  'moonshine-base': 'voice_engine_model_moonshineBase',
  'whisper-base': 'voice_engine_model_whisper',
  vosk: 'voice_engine_model_vosk',
  kitten: 'voice_engine_model_kitten',
  kokoro: 'voice_engine_model_kokoro',
};

/** What the background says is installed (packed in the extension or downloaded). */
export async function installedVoiceModels(request: Request): Promise<InstalledVoiceModels> {
  const status = await request<{ installed?: InstalledVoiceModels }>({ type: 'voice_engine_status' });
  return status.installed ?? {};
}

/** Local voice models (speech-to-text, read-aloud voices, the wake word's recogniser), downloaded in this page. */
export function voiceModelRequirement(ids: VoiceModelId[], request: Request): Requirement {
  return {
    id: `voice:${ids.join('+')}`,
    label: ids.map(id => t(VOICE_MODEL_NAMES[id])).join(', '),
    sizeBytes: bytesFor(ids),
    isReady: async () => {
      const installed = await installedVoiceModels(request);
      return ids.every(id => Boolean(installed[id]));
    },
    install: async (onProgress, signal) => {
      const stop = subscribeDownloads(() => {
        const state = downloadState();
        if (state.phase === 'downloading') onProgress({ received: state.received, total: state.total });
      });
      const abort = () => cancelDownload();
      signal.addEventListener('abort', abort);
      try {
        const ok = await startDownload(ids, () => request({ type: 'voice_models_changed' }));
        if (!ok && !signal.aborted) {
          const kind = downloadState().error ?? 'other';
          throw new Error(t(`voice_models_error_${kind}` as Parameters<typeof t>[0]));
        }
      } finally {
        stop();
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

/**
 * What a voice feature (talk, dictation, the wake word) still needs downloaded, as the background reckons it
 * (`voice_models_needed`): ready when nothing required is missing.
 */
export async function voiceFeatureRequirement(
  feature: 'talk' | 'dictation' | 'wake' | 'ambient',
  request: Request,
): Promise<Requirement> {
  const needed = await request<{ required?: VoiceModelId[]; optional?: VoiceModelId[] }>({
    type: 'voice_models_needed',
    feature,
  }).catch(() => ({ required: [] as VoiceModelId[], optional: [] as VoiceModelId[] }));
  const ids = [...(needed.required ?? []), ...(needed.optional ?? [])];
  // With nothing missing, name what the feature runs on
  const usual: VoiceModelId[] = feature === 'wake' ? ['vosk'] : ['moonshine-tiny', 'kitten'];
  const models = voiceModelRequirement(ids.length ? ids : usual, request);
  return {
    ...models,
    id: `voice-feature:${feature}`,
    isReady: async () => {
      const again = await request<{ required?: VoiceModelId[] }>({ type: 'voice_models_needed', feature });
      return (again.required ?? []).length === 0;
    },
  };
}

/** The saved Ollama provider, if any: its id and the server's root. */
export async function savedOllama(): Promise<{ id: string; root: string } | null> {
  const providers = await llmProviderStore.getProviderSummaries().catch(() => ({}) as Record<string, ProviderConfig>);
  const entry = Object.entries(providers).find(
    ([id, config]) => (config.type ?? getProviderTypeByProviderId(id)) === ProviderTypeEnum.Ollama,
  );
  return entry ? { id: entry[0], root: ollamaRoot(entry[1].baseUrl) } : null;
}

const startOllamaSteps = () => [
  t('requirement_ollama_step_install'),
  t('requirement_ollama_step_start'),
  t('requirement_ollama_step_lmstudio'),
];

/**
 * An Ollama model, pulled through the server's own `/api/pull`. With no server answering, it is steps (install
 * and start Ollama, or download it in LM Studio's own Discover tab) and "Check again".
 */
export async function ollamaModelRequirement(
  model: string,
  options: { sizeBytes?: number; root?: string; fetchImpl?: typeof fetch } = {},
): Promise<Requirement> {
  const root = options.root ?? (await savedOllama())?.root ?? ollamaRoot();
  const listed = await listOllamaModels(root, options.fetchImpl);
  const base = {
    id: `ollama:${model}`,
    label: model,
    sizeBytes: options.sizeBytes,
    isReady: async () => hasOllamaModel((await listOllamaModels(root, options.fetchImpl)) ?? [], model),
  };
  if (listed === null) {
    return {
      ...base,
      steps: [...startOllamaSteps(), t('requirement_ollama_step_pull', [model])],
      link: { url: OLLAMA_DOWNLOAD_URL, label: t('requirement_ollama_get') },
    };
  }
  return {
    ...base,
    install: async (onProgress, signal) => {
      try {
        await pullOllamaModel(root, model, onProgress, signal, options.fetchImpl);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(t('requirement_ollama_failed', [error instanceof Error ? error.message : String(error)]));
      }
    },
  };
}

/** The embedding model local search uses: Ollama must be added in Models, and have the model. */
export async function embedRequirement(fetchImpl?: typeof fetch): Promise<Requirement> {
  const model = (await kbSettingsStore.getSettings()).localEmbedModel || DEFAULT_EMBED_MODEL;
  const ollama = await savedOllama();
  const pull = await ollamaModelRequirement(model, { sizeBytes: 274e6, root: ollama?.root, fetchImpl });
  if (ollama) return pull;
  return {
    ...pull,
    install: undefined,
    isReady: async () => Boolean(await savedOllama()) && (await pull.isReady()),
    steps: [...(pull.steps ?? []), t('requirement_ollama_step_add')],
    link: { url: settingsPageUrl('#models/local'), label: t('requirement_open_models') },
  };
}

/** A local text model (economy voice's "On this computer"): a saved local provider whose server has a chat model. */
export async function localChatRequirement(fetchImpl?: typeof fetch): Promise<Requirement> {
  const providers = await llmProviderStore.getProviderSummaries().catch(() => ({}) as Record<string, ProviderConfig>);
  const local = Object.entries(providers).filter(([id, config]) =>
    isLocalProvider({ ...config, type: config.type ?? getProviderTypeByProviderId(id) }),
  );
  const lmStudio = local.find(
    ([id, config]) => (config.type ?? getProviderTypeByProviderId(id)) === ProviderTypeEnum.LMStudio,
  );
  const ollama = await savedOllama();
  const chatModels = async () => {
    const names = ollama ? ((await listOllamaModels(ollama.root, fetchImpl)) ?? []) : [];
    return names.filter(name => !/embed/i.test(name));
  };
  const isReady = async () => Boolean(lmStudio) || (await chatModels()).length > 0;
  if (lmStudio) return { id: 'local-chat', label: t('requirement_localChat'), isReady };
  if (!ollama) {
    return {
      id: 'local-chat',
      label: t('requirement_localChat'),
      isReady,
      steps: [...startOllamaSteps(), t('requirement_ollama_step_add')],
      link: { url: settingsPageUrl('#models/local'), label: t('requirement_open_models') },
    };
  }
  const pull = await ollamaModelRequirement(DEFAULT_LOCAL_CHAT_MODEL, {
    sizeBytes: 2.5e9,
    root: ollama.root,
    fetchImpl,
  });
  return { ...pull, id: 'local-chat', label: DEFAULT_LOCAL_CHAT_MODEL, isReady };
}

/** Ava Brain, the companion on the Mac: installed and paired there, by the user. */
export function brainRequirement(): Requirement {
  return {
    id: 'brain',
    label: t('brain_settings_title'),
    isReady: async () => (await brainSettingsStore.getSettings()).paired,
    steps: [t('requirement_brain_step_install'), t('brain_pair_hint'), t('requirement_brain_step_code')],
    link: { url: settingsPageUrl('#connections/brain'), label: t('requirement_brain_open') },
  };
}

/** Folder access for the Obsidian vault: Brave keeps it behind a flag, unless Ava Brain reaches the vault on the Mac. */
export function obsidianRequirement(): Requirement {
  return {
    id: 'obsidian',
    label: t('settings_obsidian'),
    isReady: async () => vaultSupport() === 'ok' || (await brainSettingsStore.getSettings()).paired,
    steps: [t('vault_brave_step1'), t('vault_brave_step2'), t('vault_brave_step3')],
    link: { url: BRAVE_FLAG_URL, label: t('vault_brave_open') },
  };
}
