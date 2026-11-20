import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// The kinds of action that change something outside the browser and cannot be taken back
export const COMMIT_KINDS = ['send', 'publish', 'submit', 'delete', 'purchase', 'permission'] as const;
export type CommitKind = (typeof COMMIT_KINDS)[number];

// What the agent needs from the user before it can go on: a step on the page, or a higher daily cost cap
export type NeedsUserKind = 'login' | 'captcha' | 'code' | 'cap' | 'questions';

// One piece of content the action would commit, read back from the page
export interface ConfirmField {
  label: string;
  value: string;
}

/**
 * A request for the user to decide, sent from the background to the side panel.
 * 'commit' asks to approve an action before it runs. 'needs_user' asks the user to do a step
 * on the page themselves (sign in, solve a CAPTCHA, enter a code) and then continue.
 */
export interface ConfirmRequest {
  id: string;
  taskId: string;
  mode: 'commit' | 'needs_user';
  // 'tool': a connector tool whose name says nothing more specific
  kind: CommitKind | NeedsUserKind | 'tool';
  // What the agent is about to do, in its own words
  intent: string;
  // The control the action targets, e.g. the button label
  target: string;
  pageTitle: string;
  pageUrl: string;
  fields: ConfirmField[];
  // Text of the dialog the control sits in, when there is one
  context: string;
  // What the agent needs to know to finish a form, all asked at once (kind 'questions')
  questions?: string[];
  // This step, or one like it, already exists in this task (see ../once): it is 'done', or it was 'started' and
  // cut off before its result was recorded. The card says so, and only the user's click runs it again.
  repeat?: { status: 'started' | 'done'; at: number; label: string };
}

// Interface for the confirm gate settings
export interface GateSettingsConfig {
  // Ask before an action of this kind runs. All on by default.
  confirm: Record<CommitKind, boolean>;
}

export type GateSettingsStorage = BaseStorage<GateSettingsConfig> & {
  getSettings: () => Promise<GateSettingsConfig>;
  setConfirm: (kind: CommitKind, enabled: boolean) => Promise<void>;
};

export const DEFAULT_GATE_SETTINGS: GateSettingsConfig = {
  confirm: { send: true, publish: true, submit: true, delete: true, purchase: true, permission: true },
};

const storage = createStorage<GateSettingsConfig>('gate-settings', DEFAULT_GATE_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const gateSettingsStore: GateSettingsStorage = {
  ...storage,
  async getSettings() {
    const settings = await storage.get();
    // A kind missing from stored settings is confirmed, so a new kind is never silently off
    return { confirm: { ...DEFAULT_GATE_SETTINGS.confirm, ...settings?.confirm } };
  },
  async setConfirm(kind: CommitKind, enabled: boolean) {
    const current = await gateSettingsStore.getSettings();
    await storage.set({ confirm: { ...current.confirm, [kind]: enabled } });
  },
};
