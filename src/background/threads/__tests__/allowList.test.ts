import { describe, expect, it, vi } from 'vitest';
import { isUrlAllowed } from '../../browser/util';

vi.mock('@extension/storage', () => ({
  agentModelStore: {},
  AgentNameEnum: { Navigator: 'navigator', Planner: 'planner' },
  firewallStore: {},
  generalSettingsStore: {},
  llmProviderStore: {},
}));
vi.mock('../../agent/executor', () => ({ Executor: class {} }));
vi.mock('../../browser/context', () => ({ default: class {} }));
vi.mock('../../llm/providers', () => ({ createChatModel: () => ({}) }));
vi.mock('../../usage/meter', () => ({ meterModel: (model: unknown) => model }));

const { allowListFor } = await import('../factory');

const off = { enabled: false, allowList: [], denyList: [] };

describe('allowListFor', () => {
  it('keeps an agent to its own sites, subdomains included', () => {
    const list = allowListFor(off, ['*.github.com', 'news.ycombinator.com']);
    expect(isUrlAllowed('https://api.github.com/x', list, [])).toBe(true);
    expect(isUrlAllowed('https://news.ycombinator.com/', list, [])).toBe(true);
    expect(isUrlAllowed('https://evil.example/', list, [])).toBe(false);
    expect(isUrlAllowed('https://github.com.evil.example/', list, [])).toBe(false);
  });

  it('keeps only the agent sites the firewall allows, and never opens everything when none is left', () => {
    const firewall = { enabled: true, allowList: ['github.com'], denyList: ['gist.github.com'] };
    expect(allowListFor(firewall, ['github.com', 'example.com'])).toEqual(['github.com']);
    const none = allowListFor(firewall, ['example.com', 'gist.github.com']);
    expect(isUrlAllowed('https://example.com/', none, firewall.denyList)).toBe(false);
    expect(isUrlAllowed('https://github.com/', none, firewall.denyList)).toBe(false);
  });

  it('is the firewall as it is for a chat with no agent sites', () => {
    expect(allowListFor(off)).toEqual([]);
    expect(allowListFor({ enabled: true, allowList: ['a.com'], denyList: [] }, [])).toEqual(['a.com']);
  });
});
