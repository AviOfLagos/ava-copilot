import { isLocalProvider, isLocalUrl, llmProviderStore } from '@extension/storage';
import { COMPANION_DEFAULT_PORT } from '@src/shared/lib/protocol/companion';
import { brainSettingsStore } from '../companion/state';
import { createLogger } from '../log';

const logger = createLogger('LocalServers');

/**
 * Ollama refuses (403) any request whose Origin is not on its list, and a browser extension is not on it unless the
 * user sets OLLAMA_ORIGINS. The extension's own requests to model servers on this machine go without an Origin, so
 * Ollama and LM Studio answer with no setting to change.
 *
 * Only this extension's requests, only to localhost, and only to the model servers' ports: Nex Brain's port never,
 * since Nex Brain checks the Origin to know the request is Nex Copilot's.
 */

// Ollama, LM Studio
export const DEFAULT_LOCAL_MODEL_PORTS = [11434, 1234];
const FIRST_RULE_ID = 7100;
const MAX_RULES = 20;

function portOf(url: string | undefined): number | null {
  if (!url || !isLocalUrl(url)) return null;
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/** The ports of the model servers on this machine: the usual two, and any local provider's own. */
export function localModelPorts(baseUrls: (string | undefined)[], brainPort: number): number[] {
  const ports = new Set(DEFAULT_LOCAL_MODEL_PORTS);
  for (const url of baseUrls) {
    const port = portOf(url);
    if (port !== null) ports.add(port);
  }
  ports.delete(brainPort);
  ports.delete(COMPANION_DEFAULT_PORT);
  return [...ports].sort((a, b) => a - b).slice(0, MAX_RULES);
}

/** One rule per port: this extension's requests to localhost on it go without an Origin header. */
export function originRules(ports: number[], extensionId: string): chrome.declarativeNetRequest.Rule[] {
  return ports.map((port, index) => ({
    id: FIRST_RULE_ID + index,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [{ header: 'origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation }],
    },
    condition: {
      regexFilter: `^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}/`,
      initiatorDomains: [extensionId],
      resourceTypes: [
        'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
        'other' as chrome.declarativeNetRequest.ResourceType,
      ],
    },
  }));
}

export async function installLocalServerRules(): Promise<void> {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.updateSessionRules) return;
  const providers = await llmProviderStore.getAllProviders().catch(() => ({}));
  const baseUrls = Object.values(providers)
    .filter(config => isLocalProvider(config))
    .map(config => config.baseUrl);
  const { port: brainPort } = await brainSettingsStore.getSettings();
  const rules = originRules(localModelPorts(baseUrls, brainPort), chrome.runtime.id);
  const existing = await dnr.getSessionRules();
  const removeRuleIds = existing
    .map(rule => rule.id)
    .filter(id => id >= FIRST_RULE_ID && id < FIRST_RULE_ID + MAX_RULES);
  await dnr.updateSessionRules({ removeRuleIds, addRules: rules });
}

/** Session rules go when the browser closes: put them back on every start, and when a local provider changes. */
export function keepLocalServerRules(): void {
  const install = () => void installLocalServerRules().catch(error => logger.warning('Local model rules', error));
  install();
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(key => key === 'llm-api-keys' || key === 'brain-settings')) {
      install();
    }
  });
}
