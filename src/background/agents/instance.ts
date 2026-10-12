import { db, firewallStore, gateSettingsStore, generalSettingsStore } from '@extension/storage';
import { isUrlAllowed } from '../browser/util';
import { jobs } from '../jobs/runner';
import { resolveRole } from '../models/roles';
import { services } from '../registry/services';
import { postToInbox, settleInboxItem } from '../workflows/inbox';
import { workflowService } from '../workflows/instance';
import { RUN_JOB, runKey } from '../workflows/service';
import { AgentService } from './service';
import { AgentWindow } from './window';
import { WorkflowTabTriggers } from './workflow-tab';

/**
 * The background's one agent service and agents' window. Other streams reach agents through them, e.g. the
 * Inbox waking agents (`agentService.onInboxItem(item)`, also done by a Dexie hook in register.ts).
 */

// A tab a running chat holds is never reused for another run
const holder = (tabId: number): boolean => {
  try {
    return services().threads.holderOf(tabId) !== null;
  } catch {
    return false;
  }
};

export const agentWindow = new AgentWindow(holder);

const workflowTabs = new WorkflowTabTriggers({
  createRun: (workflow, options) => workflowService.engine.createRun(workflow, options),
  async start(runId) {
    await jobs.schedule({ kind: RUN_JOB, key: runKey(runId), runAt: Date.now(), payload: { runId } });
    void workflowService.execute(runId);
  },
});

export const agentService = new AgentService({
  db,
  jobs,
  threads: () => services().threads,
  window: agentWindow,
  maxConcurrent: async () => (await generalSettingsStore.getSettings()).maxConcurrentThreads,
  async siteAllowed(url) {
    const firewall = await firewallStore.getFirewall();
    return isUrlAllowed(url, firewall.enabled ? firewall.allowList : [], firewall.enabled ? firewall.denyList : []);
  },
  async roleModel(agent) {
    const choice = await resolveRole(agent.modelRole, { agentId: agent.id, workspaceId: agent.workspaceId });
    return { provider: choice.providerId, modelName: choice.model };
  },
  inbox: draft => postToInbox(draft),
  settleInbox: (source, externalId) => settleInboxItem(source, externalId),
  gateAsksForAll: async () => Object.values((await gateSettingsStore.getSettings()).confirm).every(Boolean),
  onWorkflowTab: async event => {
    await workflowTabs.fire(event);
  },
});
