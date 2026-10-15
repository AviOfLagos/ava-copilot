import { t } from '@extension/i18n';
import {
  agentModelStore,
  AgentNameEnum,
  firewallStore,
  generalSettingsStore,
  llmProviderStore,
  personalityStore,
  threadStore,
} from '@extension/storage';
import type { ModelConfig } from '@extension/storage';
import BrowserContext from '../browser/context';
import { isHostName, siteHost } from '../agents/patterns';
import { Executor } from '../agent/executor';
import type { TaskImages } from '../agent/messages/service';
import { createChatModel } from '../llm/providers';
import type { ChatModel } from '../llm/types';
import { meterModel } from '../usage/meter';
import type { UsageScope } from '../usage/meter';
import type { TabBinding } from './binding';
import { buildCoreSection } from '../identity/prompt';
import { loadIdentityContext } from '../identity/context';

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

// Matches no site: an allow list of it lets nothing through
const NO_SITE = 'no-site.invalid';

/**
 * The sites a browser context may open: the firewall's allow list, or, for an agent kept to its own sites, those
 * of them the firewall allows as whole sites (never "everything" when none is left). Agent sites are read by the
 * same parser as the agent's own check (siteHost), and only as plain host names, which the browser's check matches
 * the same way: the site and its subdomains. A firewall entry for one page never opens a whole site.
 */
export function allowListFor(
  firewall: { enabled: boolean; allowList: string[]; denyList: string[] },
  onlyDomains: readonly string[] = [],
): string[] {
  if (!onlyDomains.length) return firewall.enabled ? firewall.allowList : [];
  // As the browser's check reads them: a plain host name as written covers the site and its subdomains
  const wholeSites = firewall.allowList.filter(isHostName);
  const withinFirewall = (host: string) =>
    !firewall.enabled ||
    !firewall.allowList.length ||
    wholeSites.some(site => host === site || host.endsWith(`.${site}`));
  const allowed = new Set<string>();
  for (const entry of onlyDomains) {
    const host = siteHost(entry);
    if (host !== null && withinFirewall(host)) allowed.add(host);
  }
  return allowed.size ? [...allowed] : [NO_SITE];
}

/**
 * A browser context limited to the thread's tabs, with the firewall and page-load settings applied. An agent's
 * chat passes the agent's sites: its pages stay on them from the first step, not only after a check.
 */
export async function createBrowserContext(
  binding: TabBinding,
  { onlyDomains }: { onlyDomains?: readonly string[] } = {},
): Promise<BrowserContext> {
  const firewall = await firewallStore.getFirewall();
  const settings = await generalSettingsStore.getSettings();
  const browserContext = new BrowserContext({
    allowedUrls: allowListFor(firewall, onlyDomains),
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
  media?: TaskImages | null;
}): Promise<Executor> {
  const settings = await generalSettingsStore.getSettings();
  // The personality of the thread's workspace (or the active one); a failure to read it keeps the default
  const thread = await threadStore.get(options.threadId).catch(() => undefined);
  const personality = await personalityStore.resolve(thread?.workspaceId).catch(() => null);
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
    media: options.media,
    personality,
    identitySection: buildCoreSection(await loadIdentityContext(thread?.workspaceId)),
  });
}
