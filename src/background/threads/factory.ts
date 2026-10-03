import { t } from '@extension/i18n';
import {
  agentModelStore,
  AgentNameEnum,
  firewallStore,
  generalSettingsStore,
  llmProviderStore,
} from '@extension/storage';
import type { ModelConfig } from '@extension/storage';
import BrowserContext from '../browser/context';
import { Executor } from '../agent/executor';
import { createChatModel } from '../llm/providers';
import type { ChatModel } from '../llm/types';
import { meterModel } from '../usage/meter';
import type { UsageScope } from '../usage/meter';
import type { TabBinding } from './binding';

export interface RunModels {
  navigator: ChatModel;
  planner: ChatModel;
}

/**
 * Builds the models a run uses: the thread's own model for both agents when it has one, otherwise
 * the agent models from settings. Every call is metered against the thread.
 */
export async function resolveModels(override: ModelConfig | null, scope: UsageScope): Promise<RunModels> {
  const providers = await llmProviderStore.getAllProviders();
  if (Object.keys(providers).length === 0) {
    throw new Error(t('bg_setup_noApiKeys'));
  }
  await agentModelStore.cleanupLegacyValidatorSettings();
  const agentModels = await agentModelStore.getAllAgentModels();

  const navigatorConfig = override ?? agentModels[AgentNameEnum.Navigator];
  if (!navigatorConfig) {
    throw new Error(t('bg_setup_noNavigatorModel'));
  }
  const plannerConfig = override ?? agentModels[AgentNameEnum.Planner] ?? navigatorConfig;

  const build = (config: ModelConfig) => {
    const provider = providers[config.provider];
    if (!provider) {
      throw new Error(t('bg_setup_noProvider', [config.provider]));
    }
    return meterModel(createChatModel(provider, config), scope);
  };
  const navigator = build(navigatorConfig);
  return { navigator, planner: plannerConfig === navigatorConfig ? navigator : build(plannerConfig) };
}

/**
 * A browser context limited to the thread's tabs, with the firewall and page-load settings applied.
 */
export async function createBrowserContext(binding: TabBinding): Promise<BrowserContext> {
  const firewall = await firewallStore.getFirewall();
  const settings = await generalSettingsStore.getSettings();
  const browserContext = new BrowserContext({
    allowedUrls: firewall.enabled ? firewall.allowList : [],
    deniedUrls: firewall.enabled ? firewall.denyList : [],
    minimumWaitPageLoadTime: settings.minWaitPageLoad / 1000.0,
    displayHighlights: settings.displayHighlights,
  });
  browserContext.setBinding(binding);
  return browserContext;
}

/**
 * Builds the executor of one run of a thread. The thread id is the task id, so usage, events and
 * confirmation requests all carry it.
 */
export async function createExecutor(options: {
  threadId: string;
  task: string;
  browserContext: BrowserContext;
  models: RunModels;
  messageContext?: string;
}): Promise<Executor> {
  const settings = await generalSettingsStore.getSettings();
  return new Executor(options.task, options.threadId, options.browserContext, options.models.navigator, {
    plannerLLM: options.models.planner,
    agentOptions: {
      maxSteps: settings.maxSteps,
      maxFailures: settings.maxFailures,
      maxActionsPerStep: settings.maxActionsPerStep,
      useVision: settings.useVision,
      useVisionForPlanner: true,
      planningInterval: settings.planningInterval,
    },
    generalSettings: settings,
    messageContext: options.messageContext,
  });
}
