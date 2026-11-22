import {
  AgentNameEnum,
  agentModelStore,
  calendarSettingsStore,
  getProviderTypeByProviderId,
  kbSettingsStore,
  llmProviderStore,
  LM_STUDIO_BASE_URL,
  obsidianVaultStore,
  providerIsUsable,
  ProviderTypeEnum,
  upcomingEventsStore,
  VAULT_STATE_KEY,
} from '@extension/storage';
import type { ProviderConfig, VaultState } from '@extension/storage';
import { hasOllamaModel } from '@src/side-panel/requirements/ollama';
import { backupStatusStore } from '../backup/state';
import { companionClient } from '../companion/client';
import { brainSettingsStore, brainStatusStore } from '../companion/state';
import { meetVoiceStore } from '../meet-voice/state';
import { ollamaRoot, providerBaseUrl } from '../models/discovery';
import { installedVoiceModels } from '../voice/engines/models';
import { whatsappRemoteStateStore } from '../whatsapp-remote/state';
import type { LocalReading, SetupReadings } from './checks';
import type { SetupBrainInfo } from './state';

/**
 * The readings the checks need, from the same places the features read: the model settings, the local server's own
 * model list, the background's voice model list, Ava Brain's status, and the stores each feature keeps. `fresh`
 * also asks Ava Brain again (Ava's browser, WhatsApp) — the scheduled check and "Check again" do; a storage change
 * only reads what is stored, so a check never triggers another.
 */

const LOCAL_TIMEOUT_MS = 2000;
const DEFAULT_OLLAMA_ROOT = 'http://localhost:11434';

/** A local server's model list (Ollama `/api/tags`, LM Studio `/v1/models`), or null when it does not answer. */
async function listLocal(kind: 'ollama' | 'lmstudio', root: string, fetchFn: typeof fetch): Promise<string[] | null> {
  try {
    const url = kind === 'ollama' ? `${root}/api/tags` : `${root}/models`;
    const response = await fetchFn(url, { signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = (await response.json()) as { models?: { name?: string; model?: string }[]; data?: { id?: string }[] };
    if (kind === 'ollama') return (body.models ?? []).map(m => String(m.name ?? m.model ?? '')).filter(Boolean);
    return (body.data ?? []).map(m => String(m.id ?? '')).filter(Boolean);
  } catch {
    return null;
  }
}

export async function readLocal(fetchFn: typeof fetch = fetch): Promise<LocalReading> {
  const providers = await llmProviderStore.getProviderSummaries().catch(() => ({}) as Record<string, ProviderConfig>);
  const typeOf = (id: string, config: ProviderConfig) => config.type ?? getProviderTypeByProviderId(id);
  const ollama = Object.entries(providers).find(([id, config]) => typeOf(id, config) === ProviderTypeEnum.Ollama);
  const lmStudio = Object.entries(providers).find(([id, config]) => typeOf(id, config) === ProviderTypeEnum.LMStudio);
  const embedModel = (await kbSettingsStore.getSettings().catch(() => null))?.localEmbedModel || 'nomic-embed-text';

  const fromOllama = (names: string[], providerId: string | null, root: string): LocalReading => ({
    kind: 'ollama',
    providerId,
    saved: providerId !== null,
    answers: true,
    root,
    chatModels: names.filter(name => !/embed/i.test(name)),
    embed: hasOllamaModel(names, embedModel),
  });
  const fromLmStudio = (names: string[], providerId: string | null, root: string): LocalReading => ({
    kind: 'lmstudio',
    providerId,
    saved: providerId !== null,
    answers: true,
    root,
    chatModels: names.filter(name => !/embed/i.test(name)),
    embed: names.some(name => /nomic-embed/i.test(name)),
  });

  if (ollama) {
    const root = ollamaRoot(ollama[1].baseUrl);
    const names = await listLocal('ollama', root, fetchFn);
    if (names) return fromOllama(names, ollama[0], root);
  }
  if (lmStudio) {
    const root = providerBaseUrl(ProviderTypeEnum.LMStudio, lmStudio[1].baseUrl) ?? LM_STUDIO_BASE_URL;
    const names = await listLocal('lmstudio', root, fetchFn);
    if (names) return fromLmStudio(names, lmStudio[0], root);
  }
  // Nothing saved answers: a server on its usual port that Models does not have yet
  if (!ollama) {
    const names = await listLocal('ollama', DEFAULT_OLLAMA_ROOT, fetchFn);
    if (names) return fromOllama(names, null, DEFAULT_OLLAMA_ROOT);
  }
  if (!lmStudio) {
    const names = await listLocal('lmstudio', LM_STUDIO_BASE_URL, fetchFn);
    if (names) return fromLmStudio(names, null, LM_STUDIO_BASE_URL);
  }
  const saved = ollama ?? lmStudio ?? null;
  return {
    kind: ollama ? 'ollama' : lmStudio ? 'lmstudio' : null,
    providerId: saved?.[0] ?? null,
    saved: Boolean(saved),
    answers: false,
    root: null,
    chatModels: [],
    embed: false,
  };
}

/** The first-run setup's rule: a Navigator model whose provider can run (a key, or a local or custom server). */
export async function hasWorkingModel(): Promise<boolean> {
  const navigator = await agentModelStore.getAgentModel(AgentNameEnum.Navigator).catch(() => undefined);
  if (!navigator) return false;
  const provider = await llmProviderStore.getProvider(navigator.provider).catch(() => undefined);
  return providerIsUsable(provider, navigator.provider);
}

const STT_MODELS = ['moonshine-tiny', 'moonshine-base', 'whisper-base'] as const;
const TTS_MODELS = ['kitten', 'kokoro'] as const;

export async function readVoice(): Promise<{ stt: boolean; tts: boolean }> {
  const installed = await installedVoiceModels().catch(() => ({}) as Record<string, unknown>);
  return {
    stt: STT_MODELS.some(id => Boolean(installed[id])),
    tts: TTS_MODELS.some(id => Boolean(installed[id])),
  };
}

export async function readBrain(): Promise<SetupReadings['brain'] & { info: SetupBrainInfo }> {
  const [settings, status] = await Promise.all([brainSettingsStore.getSettings(), brainStatusStore.getStatus()]);
  // Unpaired: whether Ava Brain answers at all, so the step says "pair" rather than "install"
  const reachable = settings.paired ? status.state !== 'offline' : await companionClient.reachable().catch(() => false);
  return {
    paired: settings.paired,
    state: settings.paired ? status.state : 'unpaired',
    reachable,
    info: {
      reachable,
      docker: status.docker?.state ?? null,
      dockerMessage: status.docker?.message ?? null,
    },
  };
}

async function readAva(fresh: boolean, brainOnline: boolean): Promise<SetupReadings['ava']> {
  if (fresh && brainOnline) {
    try {
      const { status } = await companionClient.meetStatus();
      await meetVoiceStore.update({ status, checkedAt: Date.now() });
      return status;
    } catch {
      // What was stored stands
    }
  }
  return (await meetVoiceStore.getState()).status;
}

async function readWhatsApp(fresh: boolean, brainOnline: boolean): Promise<SetupReadings['whatsapp']> {
  if (fresh && brainOnline) {
    try {
      const { status } = await companionClient.whatsappStatus();
      // The code to scan never goes in storage
      await whatsappRemoteStateStore.update({ status: { ...status, qr: null }, checkedAt: Date.now() });
      return status.state;
    } catch {
      // What was stored stands
    }
  }
  return (await whatsappRemoteStateStore.getState()).status?.state ?? null;
}

async function readCalendar(paired: boolean): Promise<SetupReadings['calendar']> {
  const [settings, upcoming] = await Promise.all([calendarSettingsStore.getSettings(), upcomingEventsStore.get()]);
  return {
    source: upcoming?.source ?? null,
    error: upcoming?.error ?? null,
    needsAccess: upcoming?.needsAccess === true,
    configured: Boolean(settings.icsUrl.trim()) || (settings.macEnabled && paired),
  };
}

async function readObsidian(): Promise<SetupReadings['obsidian']> {
  const setting = await obsidianVaultStore.getSetting();
  if (setting.source === 'brain' && setting.vaultId) return { name: setting.name ?? setting.path ?? setting.vaultId };
  // The browser folder, as an extension page last saw it
  const all = (await chrome.storage.local.get(VAULT_STATE_KEY).catch(() => ({}))) as Record<string, unknown>;
  const stored = all[VAULT_STATE_KEY] as VaultState | undefined;
  return { name: stored?.name && stored.access === 'granted' ? stored.name : null };
}

export async function takeReadings(
  fresh: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<{ readings: SetupReadings; brainInfo: SetupBrainInfo }> {
  const brain = await readBrain();
  const brainOnline = brain.paired && brain.state === 'online';
  const [model, local, voice, ava, whatsapp, calendar, obsidian, backup] = await Promise.all([
    hasWorkingModel(),
    readLocal(fetchFn),
    readVoice(),
    readAva(fresh, brainOnline),
    readWhatsApp(fresh, brainOnline),
    readCalendar(brain.paired),
    readObsidian(),
    backupStatusStore.getStatus(),
  ]);
  return {
    readings: {
      hasWorkingModel: model,
      local,
      voice,
      brain: { paired: brain.paired, state: brain.state, reachable: brain.reachable },
      ava,
      whatsapp,
      calendar,
      obsidian,
      backup: { lastBackupAt: backup.lastBackupAt, lastError: backup.lastError },
    },
    brainInfo: brain.info,
  };
}
