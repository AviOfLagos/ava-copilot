import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';

/**
 * The name shown in the shell's profile button and initials avatar. Purely cosmetic and local to
 * this browser: there is no account system behind it, hence "Local" next to it in the drawer.
 */
export interface AccountProfile {
  displayName: string;
}

const DEFAULT_ACCOUNT_PROFILE: AccountProfile = { displayName: '' };

const storage = createStorage<AccountProfile>('account-profile', DEFAULT_ACCOUNT_PROFILE, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const accountProfileStore = {
  ...storage,

  /** The user's chosen name, trimmed; empty until they set one (the UI then shows "You"). */
  async getDisplayName(): Promise<string> {
    const profile = (await storage.get()) ?? DEFAULT_ACCOUNT_PROFILE;
    return profile.displayName.trim();
  },

  async setDisplayName(name: string): Promise<void> {
    await storage.set({ displayName: name.trim().slice(0, 60) });
  },
};
