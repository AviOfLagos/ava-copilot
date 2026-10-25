import { createStorage } from '@extension/storage/lib/base/base';
import { StorageEnum } from '@extension/storage/lib/base/enums';

/**
 * The setup checklist (Settings › General › Setup, the first-run setup and the header's dot): what is set up, what
 * is not and why, and what the user skipped. Written by the background only, from the real status of each part
 * (models, Ava Brain, Ava's browser, WhatsApp, the calendar, Obsidian, backups); pages read it live.
 */

export const SETUP_ITEM_IDS = [
  'model',
  'local',
  'voice',
  'brain',
  'ava',
  'whatsapp',
  'calendar',
  'obsidian',
  'backup',
] as const;
export type SetupItemId = (typeof SETUP_ITEM_IDS)[number];

// Can't be skipped: the indicator stays until each is ready
export const REQUIRED_ITEMS: SetupItemId[] = ['model', 'local', 'voice', 'brain'];
// Each has a Skip, which takes it off the indicator; it stays in the checklist and can be brought back
export const RECOMMENDED_ITEMS: SetupItemId[] = ['ava', 'whatsapp', 'calendar', 'obsidian', 'backup'];

export const isRecommended = (id: string): id is SetupItemId => (RECOMMENDED_ITEMS as string[]).includes(id);

/** Why an item is not ready, as a code the pages turn into a sentence and a button. */
export type SetupProblem =
  | 'model_missing'
  | 'local_off'
  | 'local_not_added'
  | 'local_no_chat'
  | 'local_no_embed'
  | 'voice_missing'
  | 'brain_unreachable'
  | 'brain_unpaired'
  | 'brain_offline'
  | 'needs_brain'
  | 'ava_no_browser'
  | 'ava_signed_out'
  | 'ava_unchecked'
  | 'wa_not_linked'
  | 'cal_none'
  | 'cal_error'
  | 'obs_none'
  | 'backup_never'
  | 'backup_failed';

export interface SetupItemState {
  id: SetupItemId;
  ready: boolean;
  problem: SetupProblem | null;
  // A detail shown with it: the local model in use, the account, the vault, when the last backup ran
  detail: string | null;
}

/** Facts about what Ava Brain reports, shown as information beside its item (never a reason on their own). */
export interface SetupBrainInfo {
  reachable: boolean;
  docker: 'up' | 'down' | 'missing' | null;
  dockerMessage: string | null;
}

export interface SetupState {
  items: SetupItemState[];
  skipped: SetupItemId[];
  // Required items not ready plus recommended ones neither ready nor skipped: the indicator's number
  pending: number;
  brain: SetupBrainInfo | null;
  // The local model the checks found (Ollama or LM Studio), for the local item's buttons
  local: { providerId: string | null; kind: 'ollama' | 'lmstudio' | null; root: string | null } | null;
  checkedAt: number | null;
}

export const DEFAULT_SETUP_STATE: SetupState = {
  items: [],
  skipped: [],
  pending: 0,
  brain: null,
  local: null,
  checkedAt: null,
};

export const SETUP_STATE_KEY = 'setup-state';

const storage = createStorage<SetupState>(SETUP_STATE_KEY, DEFAULT_SETUP_STATE, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

/** The indicator's number: what is still owed. */
export function pendingCount(items: SetupItemState[], skipped: SetupItemId[]): number {
  return items.filter(item => !item.ready && (REQUIRED_ITEMS.includes(item.id) || !skipped.includes(item.id))).length;
}

export const setupStore = {
  ...storage,
  async getState(): Promise<SetupState> {
    return { ...DEFAULT_SETUP_STATE, ...(await storage.get()) };
  },
  async update(changes: Partial<SetupState>): Promise<SetupState> {
    const current = await setupStore.getState();
    const next = { ...current, ...changes };
    next.skipped = [...new Set(next.skipped)].filter(isRecommended);
    next.pending = pendingCount(next.items, next.skipped);
    await storage.set(next);
    return next;
  },
};
