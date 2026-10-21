import type { ObsidianVaultSetting } from '@extension/storage';
import type { ObsidianVault } from '@src/shared/lib/protocol/companion';
import type { VaultSupport } from './vault';

/**
 * The Obsidian card's choices when Nex Brain is in play. With Nex Brain paired, the vault is read and written on
 * the Mac (src/background/obsidian): no folder picker, no access click after a restart. Without it, the browser
 * folder (./vault.ts) is the way, with Brave's flag steps when Brave keeps the picker off.
 */

export type VaultCardMode =
  // Nex Brain reads and writes the chosen vault
  | 'brain'
  // Nex Brain is paired: pick one of the vaults it found, or type a folder
  | 'brain_pick'
  // Not paired: the browser folder picker (or Brave's steps)
  | 'browser';

export function vaultCardMode(input: {
  paired: boolean;
  setting: Pick<ObsidianVaultSetting, 'source' | 'vaultId'>;
}): VaultCardMode {
  if (input.setting.source === 'brain' && input.setting.vaultId) return 'brain';
  return input.paired ? 'brain_pick' : 'browser';
}

/** Whether the browser folder part still shows under Nex Brain's: only when one is connected, so it can be let go. */
export function showBrowserFolder(mode: VaultCardMode, browserName: string | null, support: VaultSupport): boolean {
  if (mode === 'browser') return true;
  return mode === 'brain_pick' && !!browserName && support !== 'unsupported';
}

/** Vaults to offer: usable ones first, the chosen one never twice. */
export function vaultChoices(vaults: ObsidianVault[]): ObsidianVault[] {
  const seen = new Set<string>();
  return vaults
    .filter(vault => (seen.has(vault.id) ? false : (seen.add(vault.id), true)))
    .sort((a, b) => Number(b.usable) - Number(a.usable) || a.name.localeCompare(b.name));
}

/** A folder path as typed: trimmed; only full paths (/ or ~/) go to Nex Brain, which checks the rest. */
export function typedVaultPath(input: string): string | null {
  const path = input.trim();
  if (!path || path.length > 1000) return null;
  return path.startsWith('/') || path.startsWith('~/') ? path : null;
}

export class BackgroundError extends Error {
  constructor(
    message: string,
    public readonly kind: string | null,
  ) {
    super(message);
    this.name = 'BackgroundError';
  }
}

/** A one-off command to the background; its error reply becomes a thrown sentence. */
export async function askBackground<T = Record<string, unknown>>(
  type: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ type, requestId: crypto.randomUUID(), ...body })) as
    (Record<string, unknown> & { type?: string; error?: string; kind?: string }) | undefined;
  if (!reply || reply.type === 'error') {
    throw new BackgroundError(reply?.error ?? 'No answer from the background.', reply?.kind ?? null);
  }
  return reply as T;
}
