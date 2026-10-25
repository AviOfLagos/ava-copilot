import { describe, expect, it } from 'vitest';
import type { ObsidianVault } from '@src/shared/lib/protocol/companion';
import { showBrowserFolder, typedVaultPath, vaultCardMode, vaultChoices } from '../brain';

const vault = (id: string, name: string, usable = true): ObsidianVault => ({
  id: id.padEnd(16, '0'),
  name,
  path: `/Users/avi/${name}`,
  found: 'obsidian',
  usable,
});

describe('vaultCardMode', () => {
  it('uses Ava Brain’s vault once chosen, offers Ava Brain’s vaults when paired, else the browser folder', () => {
    expect(vaultCardMode({ paired: true, setting: { source: 'brain', vaultId: 'abc' } })).toBe('brain');
    // Chosen before and now unpaired: still shown, so the user sees why sync stopped and can let go
    expect(vaultCardMode({ paired: false, setting: { source: 'brain', vaultId: 'abc' } })).toBe('brain');
    expect(vaultCardMode({ paired: true, setting: { source: null, vaultId: null } })).toBe('brain_pick');
    expect(vaultCardMode({ paired: false, setting: { source: null, vaultId: null } })).toBe('browser');
  });
});

describe('showBrowserFolder', () => {
  it('keeps the browser folder (and Brave’s steps) as the fallback when not paired', () => {
    expect(showBrowserFolder('browser', null, 'brave_off')).toBe(true);
    expect(showBrowserFolder('browser', null, 'ok')).toBe(true);
  });
  it('shows a connected browser folder under Ava Brain’s choices only so it can be let go', () => {
    expect(showBrowserFolder('brain_pick', null, 'ok')).toBe(false);
    expect(showBrowserFolder('brain_pick', 'Old vault', 'ok')).toBe(true);
    expect(showBrowserFolder('brain', 'Old vault', 'ok')).toBe(false);
  });
});

describe('vaultChoices', () => {
  it('lists usable vaults first, each once', () => {
    const list = vaultChoices([vault('b', 'Gone', false), vault('a', 'Work'), vault('a', 'Work'), vault('c', 'Home')]);
    expect(list.map(item => item.name)).toEqual(['Home', 'Work', 'Gone']);
  });
});

describe('typedVaultPath', () => {
  it('takes full paths only', () => {
    expect(typedVaultPath('  ~/Documents/My Vault ')).toBe('~/Documents/My Vault');
    expect(typedVaultPath('/Users/avi/Vault')).toBe('/Users/avi/Vault');
    expect(typedVaultPath('Documents/Vault')).toBeNull();
    expect(typedVaultPath('')).toBeNull();
  });
});
