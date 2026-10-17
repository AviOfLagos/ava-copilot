import type { VoiceModelComponentId } from './catalog';
import { downloadedModels } from './store';
import type { StoreDeps } from './store';
import { extensionBase } from './resolve';

/**
 * Which local voice models this computer has: the ones packed into the extension (a dev build made after
 * `scripts/voice-models-setup.mjs` / `wake-word-setup.mjs`, listed by `voice/manifest.json` and `wake/model.tar.gz`)
 * and the ones downloaded on first use. Downloaded wins when both are there, as the runtimes read it first.
 */

export interface InstalledModel {
  bytes: number;
  // Moonshine's float weights for the GPU are there too (packed builds only)
  webgpu?: boolean;
  // Downloaded on first use (it can be removed again), rather than packed into the extension
  downloaded?: boolean;
}

export type InstalledModels = Partial<Record<VoiceModelComponentId, InstalledModel>>;

const PACKED_IDS: VoiceModelComponentId[] = ['kitten', 'kokoro', 'moonshine-tiny', 'moonshine-base', 'whisper-base'];

export function parsePackedManifest(manifest: unknown): InstalledModels {
  const components = (manifest as { components?: Record<string, { bytes?: unknown; webgpu?: unknown }> } | null)
    ?.components;
  const installed: InstalledModels = {};
  for (const id of PACKED_IDS) {
    const entry = components?.[id];
    if (!entry || typeof entry !== 'object') continue;
    const model: InstalledModel = { bytes: Number(entry.bytes) || 0 };
    if (entry.webgpu === true) model.webgpu = true;
    installed[id] = model;
  }
  return installed;
}

/** The models packed into this build. */
export async function packedModels(fetcher: typeof fetch = fetch, base = extensionBase()): Promise<InstalledModels> {
  let models: InstalledModels = {};
  try {
    const response = await fetcher(`${base}voice/manifest.json`);
    if (response.ok) models = parsePackedManifest(await response.json());
  } catch {
    // No voice/ folder in this build
  }
  try {
    const response = await fetcher(`${base}wake/model.tar.gz`);
    if (response.ok) {
      models.vosk = { bytes: Number(response.headers.get('content-length')) || 0 };
      void response.body?.cancel().catch(() => {});
    }
  } catch {
    // The wake word's model is not packed either
  }
  return models;
}

/** Packed and downloaded models together. */
export async function installedModels({
  fetcher = fetch,
  base,
  store = {},
}: { fetcher?: typeof fetch; base?: string; store?: StoreDeps } = {}): Promise<InstalledModels> {
  const [packed, downloaded] = await Promise.all([
    packedModels(fetcher, base),
    downloadedModels(store).catch(() => ({}) as Awaited<ReturnType<typeof downloadedModels>>),
  ]);
  const models: InstalledModels = { ...packed };
  for (const [id, model] of Object.entries(downloaded) as [VoiceModelComponentId, { bytes: number }][]) {
    models[id] = { ...models[id], bytes: model.bytes, downloaded: true };
  }
  return models;
}
