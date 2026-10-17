import { installedModels, parsePackedManifest } from '@extension/shared';
import type { InstalledVoiceModels } from '@extension/storage';

/**
 * Which local voice models this computer has: downloaded on first use into the extension's own storage, or packed
 * into a dev build (`voice/manifest.json` from `scripts/voice-models-setup.mjs`, `wake/model.tar.gz` from
 * `scripts/wake-word-setup.mjs`, which Vosk dictation reuses). Nothing is fetched from outside here.
 */

const CACHE_MS = 30_000;
let cached: { at: number; models: InstalledVoiceModels } | null = null;

export const parseVoiceManifest = (manifest: unknown): InstalledVoiceModels => parsePackedManifest(manifest);

/** The local models present, cached for half a minute (a finished download forgets it: `voice_models_changed`). */
export async function installedVoiceModels(fetcher: typeof fetch = fetch): Promise<InstalledVoiceModels> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  const models = await installedModels({ fetcher });
  cached = { at: Date.now(), models };
  return models;
}

export function forgetInstalledVoiceModels(): void {
  cached = null;
}
