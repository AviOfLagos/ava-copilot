import { t } from '@extension/i18n';
import {
  agentModelStore,
  AgentNameEnum,
  firewallStore,
  generalSettingsStore,
  getProviderTypeByProviderId,
  isLocalProvider,
  llmProviderStore,
  threadStore,
} from '@extension/storage';
import type { ModelConfig, RoleTarget } from '@extension/storage';
import { personalityForThread } from '../personalities/voices';
import BrowserContext from '../browser/context';
import { isHostName, siteHost } from '../agents/patterns';
import { Executor } from '../agent/executor';
import type { TaskImages } from '../agent/messages/service';
import { createChatModel } from '../llm/providers';
import type { ChatModel } from '../llm/types';
import { withCloudFallback } from '../models/fallback';
import { resolveRole } from '../models/roles';
import { meterModel } from '../usage/meter';
import type { UsageScope } from '../usage/meter';
import type { TabBinding } from './binding';
import { buildCoreSection } from '../identity/prompt';
import { loadIdentityContext } from '../identity/context';
import { buildAbilitiesSection, buildChannelSection } from '../agent/prompts/channel';
import { currentCapabilities } from '../capabilities/sources';
import { COMING } from '../capabilities/coming';

export interface RunModels {
  navigator: ChatModel;
  planner: ChatModel;
}

const sameModel = (a: { provider: string; modelName: string }, b: RoleTarget) =>
  a.provider === b.providerId && a.modelName === b.model;

/**
 * Builds the models a run uses. A thread's own model serves both agents. Otherwise the Navigator does the fast
 * role and the Planner the smart one (`resolveRole`): the agent's or workspace's mapping first, then the agent
 * models chosen in settings, then everyone's mapping and the best available, with a provider that is down stood in
 * for. A cloud model finishes a failed call on the local fallback (models/fallback.ts). Every call is metered
 * against the thread.
 */
export async function resolveModels(override: ModelConfig | null, scope: UsageScope): Promise<RunModels> {
  const providers = await llmProviderStore.getAllProviders();
  if (Object.keys(providers).length === 0) {
    throw new Error(t('bg_setup_noApiKeys'));
  }

  const build = (config: ModelConfig) => {
    const provider = providers[config.provider];
    if (!provider) {
      throw new Error(t('bg_setup_noProvider', [config.provider]));
    }
    return withCloudFallback(meterModel(createChatModel(provider, config), scope), {
      local: isLocalProvider({ ...provider, type: provider.type ?? getProviderTypeByProviderId(config.provider) }),
      scope,
    });
  };
  if (override) {
    const model = build(override);
    return { navigator: model, planner: model };
  }

  await agentModelStore.cleanupLegacyValidatorSettings();
  const agentModels = await agentModelStore.getAllAgentModels();
  const navigatorConfig = agentModels[AgentNameEnum.Navigator];
  const plannerConfig = agentModels[AgentNameEnum.Planner] ?? navigatorConfig;
  // An agent's chat uses the agent's and its workspace's mappings
  const thread =
    scope.workspaceId === undefined || scope.agentId === undefined
      ? await threadStore.get(scope.sessionId).catch(() => undefined)
      : undefined;
  const roleScope = {
    workspaceId: scope.workspaceId !== undefined ? scope.workspaceId : (thread?.workspaceId ?? null),
    agentId: scope.agentId !== undefined ? scope.agentId : (thread?.agentId ?? null),
  };
  const target = (config?: ModelConfig): RoleTarget | null =>
    config ? { providerId: config.provider, model: config.modelName } : null;
  const navigatorChoice = await resolveRole('fast', { ...roleScope, explicit: target(navigatorConfig) }).catch(
    () => null,
  );
  if (!navigatorChoice) {
    throw new Error(t('bg_setup_noNavigatorModel'));
  }
  const plannerChoice =
    (await resolveRole('smart', { ...roleScope, explicit: target(plannerConfig) }).catch(() => null)) ??
    navigatorChoice;

  // The agent's own settings (reasoning effort) stay with its model; another model gets the provider's defaults
  const configFor = (choice: RoleTarget, own?: ModelConfig): ModelConfig =>
    own && sameModel(own, choice) ? own : { provider: choice.providerId, modelName: choice.model };
  const navigatorModel = configFor(navigatorChoice, navigatorConfig);
  const plannerModel = configFor(plannerChoice, plannerConfig);
  const navigator = build(navigatorModel);
  const shared =
    sameModel(plannerModel, navigatorChoice) && plannerModel.reasoningEffort === navigatorModel.reasoningEffort;
  return { navigator, planner: shared ? navigator : build(plannerModel) };
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

/** What Ava can do now, for the planner; without it the chat still runs. */
function abilitiesSection(): string {
  try {
    return buildAbilitiesSection(currentCapabilities(), COMING);
  } catch {
    return '';
  }
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
  // An agent's run follows the agent's own personality; any other chat its workspace's (or the active one). A
  // failure to read it keeps the default
  const thread = await threadStore.get(options.threadId).catch(() => undefined);
  const personality = await personalityForThread(thread).catch(() => null);
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
    channelSection: buildChannelSection(thread?.origin),
    abilitiesSection: abilitiesSection(),
    channel: thread?.origin ?? 'user',
  });
}
