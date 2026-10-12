import type { InstalledVoiceModel, InstalledVoiceModels, VoiceModelId } from '@extension/storage';

/**
 * Which local voice models are packed with the extension: `voice/manifest.json`, written by
 * `scripts/voice-models-setup.mjs`, and the wake word's Vosk model (`wake/model.tar.gz`, from
 * `scripts/wake-word-setup.mjs`), which Vosk dictation reuses. Read from the extension's own files only.
 */

const CACHE_MS = 30_000;
let cached: { at: number; models: InstalledVoiceModels } | null = null;

const MODEL_IDS: VoiceModelId[] = ['kitten', 'kokoro', 'moonshine-tiny', 'moonshine-base', 'whisper-base'];

export function parseVoiceManifest(manifest: unknown): InstalledVoiceModels {
  const components = (manifest as { components?: Record<string, { bytes?: unknown; webgpu?: unknown }> } | null)
    ?.components;
  const installed: InstalledVoiceModels = {};
  for (const id of MODEL_IDS) {
    const entry = components?.[id];
    if (!entry || typeof entry !== 'object') continue;
    const model: InstalledVoiceModel = { bytes: Number(entry.bytes) || 0 };
    if (entry.webgpu === true) model.webgpu = true;
    installed[id] = model;
  }
  return installed;
}

/** The local models present, cached for half a minute (they only change with a rebuild). */
export async function installedVoiceModels(fetcher: typeof fetch = fetch): Promise<InstalledVoiceModels> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  let models: InstalledVoiceModels = {};
  try {
    const response = await fetcher(chrome.runtime.getURL('voice/manifest.json'));
    if (response.ok) models = parseVoiceManifest(await response.json());
  } catch {
    // Not installed: no voice/ folder in this build
  }
  try {
    const response = await fetcher(chrome.runtime.getURL('wake/model.tar.gz'));
    if (response.ok) {
      models.vosk = { bytes: Number(response.headers.get('content-length')) || 0 };
      void response.body?.cancel().catch(() => {});
    }
  } catch {
    // The wake word's model is not installed either
  }
  cached = { at: Date.now(), models };
  return models;
}

export function forgetInstalledVoiceModels(): void {
  cached = null;
}
