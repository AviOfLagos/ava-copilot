import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export interface WorkflowSettingsConfig {
  /**
   * For tests only, never shown in the UI: a step fetching an address that starts with a key fetches the value
   * in its place. Only local targets (127.0.0.1, localhost) are honoured, so it can point a template's real
   * sources at a test server and nowhere else.
   */
  urlOverrides: Record<string, string>;
}

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettingsConfig = { urlOverrides: {} };

export type WorkflowSettingsStorage = BaseStorage<WorkflowSettingsConfig> & {
  getSettings: () => Promise<WorkflowSettingsConfig>;
};

const storage = createStorage<WorkflowSettingsConfig>('workflow-settings', DEFAULT_WORKFLOW_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: false,
});

export const workflowSettingsStore: WorkflowSettingsStorage = {
  ...storage,
  async getSettings() {
    return { ...DEFAULT_WORKFLOW_SETTINGS, ...(await storage.get()) };
  },
};
