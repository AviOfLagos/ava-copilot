/**
 * What the Obsidian vault looks like, as an extension page last saw it: the folder handle lives in a page
 * (IndexedDB `avi-vault`), so the background reads this summary in `storage.local` to guide a setup.
 */

export const VAULT_STATE_KEY = 'vault-state';

export interface VaultState {
  // Whether pages can open a folder picker: Brave keeps it behind a flag
  support: 'ok' | 'brave_off' | 'unsupported' | null;
  name: string | null;
  access: 'granted' | 'prompt' | 'denied' | null;
}
